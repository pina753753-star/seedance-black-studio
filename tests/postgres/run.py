#!/usr/bin/env python3
"""Isolated real PostgreSQL tests. Docker local socket only; dummy rows; no ports.
Requires already pulled official postgres:17.11-bookworm. Never pulls images.
"""
import concurrent.futures as cf
import json, os, pathlib, subprocess, time, uuid
ROOT=pathlib.Path(__file__).resolve().parents[2]
DOCKER=['docker','-H','unix:///var/run/docker.sock']
NAME='pina-sql-test-'+uuid.uuid4().hex[:10]
IMAGE='docker.io/library/postgres:17.11-bookworm'
RESULTS=[]

def docker(*args,**kw):return subprocess.run(DOCKER+list(args),text=True,capture_output=True,check=True,**kw)
def sql(s,role=None,app='test',check=True):
    prefix="SET statement_timeout='8s'; SET lock_timeout='6s'; SET application_name='"+app+"';"
    if role:prefix+='SET ROLE '+role+';'
    p=subprocess.run(DOCKER+['exec','-i',NAME,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','pina_test'],input=prefix+s,text=True,capture_output=True,timeout=12)
    if check and p.returncode:raise AssertionError(p.stderr.strip())
    return p.stdout.strip() if check else p

def obj(s,**kw):return json.loads(sql(s,**kw))
def apply(file):sql((ROOT/file).read_text())
def reset(sub=0,free=0,purchase=100,marker=True,expiry="now()+interval '1 day'",plan='free'):
    sql('TRUNCATE generation_tasks,credit_transactions,stripe_payment_ledger,payment_risk_events,credit_balances,profiles,auth.users CASCADE;')
    u=str(uuid.uuid4());t=str(uuid.uuid4());l=str(uuid.uuid4())
    sql(f"INSERT INTO auth.users(id) VALUES('{u}'); INSERT INTO profiles(id,email,plan) VALUES('{u}','dummy@example.invalid','{plan}'); INSERT INTO credit_balances(user_id,free_credits,subscription_credits,purchased_credits,subscription_expires_at,purchased_expires_at) VALUES('{u}',{free},{sub},{purchase},now()+interval '1 day',{expiry}); INSERT INTO stripe_payment_ledger(id,user_id,purchase_type,grant_status,charge_id,payment_intent_id) VALUES('{l}','{u}','credit_pack','granted','ch_dummy','pi_dummy');")
    task(u,t,marker)
    return u,t,l

def task(u,t,marker=True):
    sql(f"INSERT INTO generation_tasks(id,user_id,status,api_provider,credit_cost,mode,prompt,settings) VALUES('{t}','{u}','queued','openrouter',60,'text_to_video','dummy test','{{\"purchase_access_required\":{str(marker).lower()}}}');")
def debit(u,t):return f"SELECT public.deduct_generation_credits_atomic('{t}','{u}',60);"
def refund(t):return f"SELECT public.refund_generation_task_atomic('{t}','dummy failure');"
def risk():return "SELECT public.record_payment_risk_event_atomic('evt_dummy','charge.dispute.created','dp_dummy','dispute','ch_dummy','pi_dummy','dummy');"
def pools(u):return obj(f"SELECT json_build_array(subscription_credits,free_credits,purchased_credits) FROM credit_balances WHERE user_id='{u}';")
def sums(u):return obj(f"SELECT json_build_array(coalesce(sum(amount) FILTER(WHERE reason='video_generation'),0),coalesce(sum(amount) FILTER(WHERE reason='generation_refund'),0)) FROM credit_transactions WHERE user_id='{u}';")
def case(name,fn):
    fn();RESULTS.append(name);print('PASS '+name,flush=True)

def ordered(first,second,expect_block=True):
    """Keep first real transaction open; prove second blocks before commit."""
    p=subprocess.Popen(DOCKER+['exec','-i',NAME,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','pina_test'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
    p.stdin.write("SET statement_timeout='10s';BEGIN;"+first+"\n\\echo FIRST_READY\n");p.stdin.flush()
    out=[]
    while True:
        line=p.stdout.readline().strip()
        if line=='FIRST_READY':break
        if not line and p.poll() is not None:raise AssertionError(p.stderr.read())
        out.append(line)
    with cf.ThreadPoolExecutor() as ex:
        f=ex.submit(sql,second,app='contender')
        deadline=time.monotonic()+4
        blocked=False
        while time.monotonic()<deadline:
            if sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='contender' AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0;")!='0':blocked=True;break
            if f.done():break
            time.sleep(.02)
        p.stdin.write('COMMIT;\n\\q\n');p.stdin.flush();p.stdin.close();p.wait(timeout=5)
        result=f.result()
    assert blocked==expect_block,'Unexpected lock behavior'
    return json.loads(next(x for x in out if x.startswith('{'))),json.loads(result.splitlines()[-1])

try:
    docker('image','inspect',IMAGE,'--format','{{.Id}}')
    docker('run','--pull=never','--detach','--name',NAME,'--network','none','--memory','512m','--cpus','2','--tmpfs','/var/lib/postgresql/data:rw','-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_DB=pina_test',IMAGE,'-c','listen_addresses=')
    for _ in range(100):
        p=docker('exec',NAME,'sh','-c','pg_isready -U postgres -d pina_test >/dev/null || true')
        try:sql('SELECT 1;');break
        except AssertionError:time.sleep(.1)
    else:raise AssertionError('DB not ready')
    meta={'image':IMAGE,'image_id':docker('image','inspect',IMAGE,'--format','{{.Id}}').stdout.strip(),'version':sql('SELECT version();'),'isolation':json.loads(docker('inspect',NAME,'--format','{{json .HostConfig}}').stdout)}
    assert meta['isolation']['NetworkMode']=='none' and not meta['isolation']['PortBindings']
    docker('exec',NAME,'mkdir','-p','/tmp/pina-fixture/tests/postgres','/tmp/pina-fixture/supabase')
    docker('cp',str(ROOT/'tests/postgres/fixture.sql'),NAME+':/tmp/pina-fixture/tests/postgres/fixture.sql')
    docker('cp',str(ROOT/'supabase/setup-01-tables.sql'),NAME+':/tmp/pina-fixture/supabase/setup-01-tables.sql')
    docker('cp',str(ROOT/'supabase/migrations'),NAME+':/tmp/pina-fixture/supabase/migrations')
    docker('exec',NAME,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','pina_test','-f','/tmp/pina-fixture/tests/postgres/fixture.sql')
    # Compare actual old versus new behavior on the same synthetic scenario.
    u,t,l=reset(sub=20,free=10,purchase=100,marker=False)
    old=obj(debit(u,t));oldp=pools(u)
    apply('docs/sql/basic-credit-access-atomic.sql')
    def parity():
        u,t,l=reset(sub=20,free=10,purchase=100,marker=False)
        assert obj(debit(u,t))==old and pools(u)==oldp
    case('old/new RPC actual legacy result and pools identical',parity)
    def good():
        u,t,l=reset(sub=20,free=10,purchase=100)
        r=obj(debit(u,t),role='service_role');assert r['code']=='deducted' and pools(u)==[0,0,70] and sums(u)==[-60,0]
    case('service role debit preserves subscription/free/purchased pool order',good)
    for role in ['anon','authenticated']:
        def denied(role=role):
            u,t,l=reset()
            for query in [debit(u,t),f"SELECT public.check_purchase_credit_access_locked('{u}');"]:
                p=sql(query,role=role,check=False);assert p.returncode!=0 and 'permission denied for function' in p.stderr
            assert pools(u)==[0,0,100]
        case(role+' cannot execute debit/helper',denied)
    for state in ['held','reversed']:
        def hold(state=state):
            u,t,l=reset();sql(f"UPDATE stripe_payment_ledger SET grant_status='{state}';")
            assert obj(debit(u,t))['code']=='payment_risk_hold' and pools(u)==[0,0,100] and sums(u)==[0,0]
        case(state+' purchase blocks without confiscation',hold)
    for expiry in ['NULL',"now()-interval '1 second'",'now()']:
        def expired(expiry=expiry):
            u,t,l=reset(expiry=expiry)
            assert obj(debit(u,t))['code']=='purchase_access_revoked' and pools(u)==[0,0,100]
        case('purchase expiry '+expiry,expired)
    def zero():
        u,t,l=reset(free=100,purchase=0);assert obj(debit(u,t))['code']=='purchase_access_revoked' and pools(u)==[0,100,0]
    case('free balance alone cannot qualify purchase marker',zero)
    def missing():
        u,t,l=reset();sql('DELETE FROM stripe_payment_ledger;');assert obj(debit(u,t))['code']=='purchase_access_revoked'
    case('no granted purchase denies',missing)
    def insufficient():
        u,t,l=reset(purchase=20);assert obj(debit(u,t))['code']=='insufficient_credits' and pools(u)==[0,0,20] and sums(u)==[0,0]
    case('insufficient balance no partial debit',insufficient)
    def owner():
        u,t,l=reset();assert obj(debit(str(uuid.uuid4()),t))['code']=='task_owner_mismatch' and pools(u)==[0,0,100]
    case('task owner mismatch denies',owner)
    def account():
        u,t,l=reset();sql("UPDATE profiles SET account_status='risk_hold';");assert obj(debit(u,t))['code']=='account_restricted'
    case('restricted account denies',account)
    def same():
        u,t,l=reset();a,b=ordered(debit(u,t),debit(u,t));assert a['code']=='deducted' and b['code']=='already_deducted' and pools(u)==[0,0,40] and sums(u)==[-60,0]
    case('concurrent same task deducts once with observed lock wait',same)
    def separate():
        u,t,l=reset();t2=str(uuid.uuid4())
        try:task(u,t2)
        except AssertionError as e:assert 'duplicate key' in str(e)
        else:raise AssertionError('second active task accepted')
        assert pools(u)==[0,0,100] and sums(u)==[0,0]
    case('real single-active index rejects second task without spending',separate)
    def riskfirst():
        u,t,l=reset();a,b=ordered(risk(),debit(u,t));assert b['code']=='payment_risk_hold' and pools(u)==[0,0,100] and sums(u)==[0,0]
    case('risk locks first then debit refuses',riskfirst)
    def debitfirst():
        u,t,l=reset();a,b=ordered(debit(u,t),risk());assert a['code']=='deducted' and b['held']==1 and pools(u)==[0,0,40]
        assert obj(debit(u,t))['code']=='already_deducted' and sums(u)==[-60,0]
    case('debit locks first then risk holds; replay never charges again',debitfirst)
    def refundtwice():
        u,t,l=reset(sub=20,free=10,purchase=100);obj(debit(u,t));a,b=ordered(refund(t),refund(t));assert a['code']=='refunded' and b['code']=='already_refunded' and pools(u)==[20,10,100] and sums(u)==[-60,60]
        t2=str(uuid.uuid4());task(u,t2);assert obj(debit(u,t2))['code']=='deducted'
    case('concurrent refund exactly once and next task remains eligible',refundtwice)
    def debitrefund():
        u,t,l=reset();a,b=ordered(debit(u,t),refund(t));assert b['code']=='refunded' and pools(u)==[0,0,100] and sums(u)==[-60,60]
    case('refund waits for same task debit and restores exactly',debitrefund)
    def refunddebit():
        u,t,l=reset();a,b=ordered(refund(t),debit(u,t));assert b['code']=='task_not_chargeable' and pools(u)==[0,0,100] and sums(u)==[0,0]
    case('refund of uncharged task first prevents later debit',refunddebit)
    def rollback():
        u,t,l=reset();p=sql('BEGIN;'+debit(u,t)+'SELECT 1/0;COMMIT;',check=False);assert p.returncode and pools(u)==[0,0,100] and sums(u)==[0,0]
    case('transaction exception rolls back debit and ledger',rollback)
    def expiryreplay():
        u,t,l=reset(purchase=60);obj(debit(u,t));sql("UPDATE credit_balances SET purchased_expires_at=now()-interval '1 day';")
        assert obj(debit(u,t))['code']=='already_deducted' and pools(u)==[0,0,0] and sums(u)==[-60,0]
    case('replay after depletion/expiry is idempotent',expiryreplay)
    def equalexpiry():
        u,t,l=reset();r=obj("BEGIN;UPDATE credit_balances SET purchased_expires_at=now();"+debit(u,t))
        assert r['code']=='purchase_access_revoked' and pools(u)==[0,0,100]
    case('purchase expiry exactly transaction now rejects',equalexpiry)
    for status in ['open','reviewing']:
        def correlated(status=status):
            u,t,l=reset();sql(f"INSERT INTO payment_risk_events(stripe_event_id,stripe_event_type,stripe_object_id,event_type,status,payment_intent_id) VALUES('evt_prior','review.opened','rev_dummy','review','{status}','pi_dummy');")
            assert obj(debit(u,t))['code']=='payment_risk_hold' and sums(u)==[0,0]
        case('unlinked '+status+' risk correlated by payment intent rejects',correlated)
    def unrelated():
        u,t,l=reset();sql("INSERT INTO payment_risk_events(stripe_event_id,stripe_event_type,stripe_object_id,event_type,payment_intent_id) VALUES('evt_other','review.opened','rev_other','review','pi_other');")
        assert obj(debit(u,t))['code']=='deducted'
    case('unrelated risk does not block owner',unrelated)
    def grantquery(u,l):return f"SELECT public.grant_stripe_credits_with_ledger_atomic('{l}','{u}',100,'purchased_credits','stripe:dummy-grant',now()+interval '1 day',null);"
    def grantfirst():
        u,t,l=reset(purchase=0);sql("UPDATE stripe_payment_ledger SET grant_status='pending';")
        a,b=ordered(grantquery(u,l),debit(u,t));assert b['code']=='deducted' and pools(u)==[0,0,40]
        r=obj(grantquery(u,l));assert r['skipped']=='duplicate' and pools(u)==[0,0,40]
    case('grant before debit qualifies once and duplicate grant adds nothing',grantfirst)
    def grantafter():
        u,t,l=reset();second=str(uuid.uuid4());sql(f"INSERT INTO stripe_payment_ledger(id,user_id,purchase_type,grant_status) VALUES('{second}','{u}','credit_pack','pending');")
        a,b=ordered(debit(u,t),grantquery(u,second));assert a['code']=='deducted' and pools(u)==[0,0,140]
    case('debit before later grant serializes without lost balance',grantafter)
    def poolrows():
        u,t,l=reset(sub=20,free=10,purchase=100);obj(debit(u,t));obj(refund(t));obj(refund(t))
        rows=obj(f"SELECT json_agg(x ORDER BY reason,credit_type) FROM (SELECT reason,credit_type,count(*) AS n,sum(amount) AS amount FROM credit_transactions WHERE user_id='{u}' GROUP BY reason,credit_type) x;")
        assert len(rows)==6 and all(x['n']==1 for x in rows)
        expected={'subscription':20,'free':10,'purchased':30}
        for x in rows:assert x['amount']==expected[x['credit_type']]*(1 if x['reason']=='generation_refund' else -1)
        assert sql(f"SELECT status FROM generation_tasks WHERE id='{t}';")=='failed'
    case('charge/refund per-pool rows exactly once and terminal status failed',poolrows)
    def partial():
        u,t,l=reset();obj(debit(u,t));sql(f"INSERT INTO credit_transactions(user_id,amount,credit_type,reason,related_task_id) VALUES('{u}',1,'purchased','generation_refund','{t}');")
        before=pools(u);r=sql(refund(t),check=False);assert r.returncode and 'refund_state_inconsistent' in r.stderr and pools(u)==before and sums(u)==[-60,1]
    case('partial refund corruption raises and does not mutate balance',partial)
    def member(expired):
        u,t,l=reset(sub=100,purchase=100,marker=expired,plan='premium')
        if expired:sql("UPDATE credit_balances SET subscription_expires_at=now()-interval '1 day';")
        r=obj(debit(u,t));assert r['code']=='deducted' and pools(u)==([0,0,40] if expired else [40,0,100])
        assert sql(f"SELECT plan FROM profiles WHERE id='{u}';")=='premium'
    case('active member additional purchase keeps sub pool priority',lambda:member(False))
    case('expired member with valid purchase excludes expired sub pool',lambda:member(True))
    def expiredrefund():
        u,t,l=reset();obj(debit(u,t));sql("UPDATE credit_balances SET purchased_expires_at=now()-interval '1 day';")
        obj(refund(t));assert pools(u)==[0,0,100]
        t2=str(uuid.uuid4());task(u,t2);assert obj(debit(u,t2))['code']=='purchase_access_revoked'
    case('refund restores amount without extending expired purchase validity',expiredrefund)
    def concurrent_admission():
        u,t,l=reset();sql('DELETE FROM generation_tasks;')
        query=f"SELECT to_jsonb(r) FROM reserve_generation_task('{u}','text_to_video','bytedance/seedance-2.5','dummy','720p',5,'9:16',60) r;"
        a,b=ordered(query,query,expect_block=False)
        assert a['task_id'] and b['rejection_reason']=='active_generation'
        assert sql('SELECT count(*) FROM generation_tasks;')=='1' and sums(u)==[0,0]
    case('concurrent actual reservation admits one task without charges',concurrent_admission)
    output={'passed':len(RESULTS),'tests':RESULTS,'image':meta['image'],'image_id':meta['image_id'],'repo_digest':docker('image','inspect',IMAGE,'--format','{{json .RepoDigests}}').stdout.strip(),'version':meta['version'],'network':'none','ports':{},'fixture':'repository base DDL and selected real migrations; synthetic auth shim and dummy data','production_applied':False}
    target=pathlib.Path('/workspace/pina-deliverables/postgres-results.json');target.write_text(json.dumps(output,indent=2))
    print(json.dumps(output,indent=2))
finally:
    subprocess.run(DOCKER+['rm','-f','-v',NAME],capture_output=True,text=True)
