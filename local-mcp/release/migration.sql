BEGIN;
-- Release candidate only. Not applied. New private schema; no existing balances or ledger changes.
CREATE SCHEMA pina_mcp;
REVOKE ALL ON SCHEMA pina_mcp FROM PUBLIC;
CREATE TABLE pina_mcp.proposals (
 id text PRIMARY KEY, owner_id text NOT NULL, quote jsonb NOT NULL,
 approval jsonb, request_id text,
 CHECK (quote->>'id'=id AND quote->>'userId'=owner_id)
);
CREATE TABLE pina_mcp.requests (
 owner_id text NOT NULL, id text NOT NULL, proposal_id text NOT NULL UNIQUE REFERENCES pina_mcp.proposals(id),
 state text NOT NULL CHECK(state IN ('pending','started','uncertain')), task_id text,
 PRIMARY KEY(owner_id,id), CHECK(state <> 'started' OR task_id IS NOT NULL)
);
-- Private invoker functions. Only fixed-search-path service-only wrappers
-- enter this schema; application callers cannot address its tables directly.
CREATE FUNCTION pina_mcp.dispatch(op text, p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pina_mcp AS $$
DECLARE q pina_mcp.proposals; r pina_mcp.requests; u text:=p->>'user'; t bigint:=(p->>'now')::bigint;
BEGIN
 IF op='create' THEN
  INSERT INTO pina_mcp.proposals VALUES(p->'quote'->>'id',p->'quote'->>'userId',p->'quote',NULL,NULL);
  RETURN '{}'::jsonb;
 END IF;
 IF op='get' THEN
  SELECT * INTO q FROM pina_mcp.proposals WHERE id=p->>'id';
  IF NOT FOUND THEN RETURN 'null'::jsonb; END IF;
  RETURN q.quote || jsonb_build_object('approved',q.approval IS NOT NULL,'approval',q.approval,'requestId',q.request_id);
 END IF;
 -- All mutations for an owner lock in one consistent order: owner, proposal,
 -- request. The transaction commits BEFORE invoking the existing start API.
 PERFORM pg_advisory_xact_lock(hashtextextended('pina_mcp:'||u,0));
 IF op IN ('request','claim') THEN
  SELECT * INTO r FROM pina_mcp.requests WHERE owner_id=u AND id=p->>'request';
  IF FOUND THEN
   IF op='claim' AND r.proposal_id<>p->>'id' THEN RETURN jsonb_build_object('error','request_conflict'); END IF;
   RETURN jsonb_build_object('fresh',false,'record',jsonb_build_object('proposalId',r.proposal_id,'state',r.state,'taskId',r.task_id));
  ELSIF op='request' THEN RETURN 'null'::jsonb; END IF;
 END IF;
 IF op IN ('approve','claim') THEN
  SELECT * INTO q FROM pina_mcp.proposals WHERE id=p->>'id' AND owner_id=u FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','not_found'); END IF;
  IF q.quote->>'fingerprint'<>p->>'hash' OR (q.quote->>'expiresAt')::bigint<=t
    OR q.quote <> p->'quote' THEN RETURN jsonb_build_object('error','proposal_changed'); END IF;
  IF q.request_id IS NOT NULL THEN RETURN jsonb_build_object('error','proposal_consumed'); END IF;
  IF op='approve' THEN
   UPDATE pina_mcp.proposals SET approval=jsonb_build_object('userId',u,'fingerprint',p->>'hash','approvedAt',t,'maxCredits',q.quote->'credits','sessionId',p->>'sessionId') WHERE id=q.id;
   RETURN '{}'::jsonb;
  END IF;
  IF q.approval IS NULL OR q.approval->>'userId'<>u OR q.approval->>'fingerprint'<>p->>'hash' THEN RETURN jsonb_build_object('error','approval_required'); END IF;
  IF EXISTS(SELECT 1 FROM pina_mcp.requests WHERE owner_id=u AND state IN ('pending','uncertain')) THEN RETURN jsonb_build_object('error','reconcile_required'); END IF;
  INSERT INTO pina_mcp.requests VALUES(u,p->>'request',q.id,'pending',NULL);
  UPDATE pina_mcp.proposals SET request_id=p->>'request' WHERE id=q.id;
  RETURN jsonb_build_object('fresh',true,'record',jsonb_build_object('proposalId',q.id,'state','pending'));
 END IF;
 IF op='complete' THEN
  UPDATE pina_mcp.requests SET state='started',task_id=p->>'task' WHERE owner_id=u AND id=p->>'request' AND state='pending';
  IF NOT FOUND THEN RETURN jsonb_build_object('error','request_state_conflict'); END IF;
 ELSIF op='uncertain' THEN
  UPDATE pina_mcp.requests SET state='uncertain' WHERE owner_id=u AND id=p->>'request' AND state='pending';
 ELSE RETURN jsonb_build_object('error','invalid_operation'); END IF;
 RETURN '{}'::jsonb;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA pina_mcp FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pina_mcp FROM PUBLIC;

CREATE TABLE pina_mcp.broker_state (
 kind text NOT NULL, id text NOT NULL, payload text NOT NULL,
 expires bigint NOT NULL, consumed bigint, grant_id text, uid text, user_code text,
 PRIMARY KEY(kind,id)
);
CREATE INDEX ON pina_mcp.broker_state(grant_id);
CREATE INDEX ON pina_mcp.broker_state(kind,uid);
CREATE INDEX ON pina_mcp.broker_state(kind,user_code);
CREATE TABLE pina_mcp.revoked_grants(id text PRIMARY KEY, revoked_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION pina_mcp.oauth_store(op text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pina_mcp AS $$
DECLARE r pina_mcp.broker_state; g text:=NULLIF(p->>'grant_id',''); k text:=p->>'kind'; i text:=p->>'id';
BEGIN
 IF op IN ('find','uid','user_code') THEN
  SELECT * INTO r FROM pina_mcp.broker_state s WHERE s.kind=k AND
   CASE op WHEN 'find' THEN s.id=i WHEN 'uid' THEN s.uid=p->>'uid' ELSE s.user_code=p->>'user_code' END;
  IF NOT FOUND OR r.expires<=extract(epoch from now()) OR EXISTS(SELECT 1 FROM pina_mcp.revoked_grants WHERE id=r.grant_id OR (k='Grant' AND id=r.id)) THEN RETURN 'null'::jsonb; END IF;
  RETURN to_jsonb(r);
 END IF;
 IF op='consume' THEN SELECT grant_id INTO g FROM pina_mcp.broker_state WHERE kind=k AND id=i; END IF;
 IF op='revoke' THEN g:=i; END IF;
 IF k='Grant' AND op='upsert' THEN g:=i; END IF;
 IF g IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('pina-broker-grant:'||g,0)); END IF;
 IF op='revoke' THEN
  INSERT INTO pina_mcp.revoked_grants(id) VALUES(g) ON CONFLICT DO NOTHING;
  DELETE FROM pina_mcp.broker_state WHERE grant_id=g OR (kind='Grant' AND id=g);
  RETURN '{}'::jsonb;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pina-broker-state:'||k||':'||i,0));
 IF op='upsert' THEN
  IF EXISTS(SELECT 1 FROM pina_mcp.revoked_grants WHERE id=g) THEN RETURN '{"error":"revoked"}'::jsonb; END IF;
  SELECT * INTO r FROM pina_mcp.broker_state WHERE kind=k AND id=i;
  IF FOUND AND r.grant_id IS DISTINCT FROM NULLIF(p->>'grant_id','') THEN RETURN '{"error":"immutable_grant"}'::jsonb; END IF;
  INSERT INTO pina_mcp.broker_state(kind,id,payload,expires,grant_id,uid,user_code)
   VALUES(k,i,p->>'payload',(p->>'expires')::bigint,NULLIF(p->>'grant_id',''),NULLIF(p->>'uid',''),NULLIF(p->>'user_code',''))
   ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload,expires=excluded.expires,uid=excluded.uid,user_code=excluded.user_code;
 ELSIF op='consume' THEN
  IF EXISTS(SELECT 1 FROM pina_mcp.revoked_grants WHERE id=g) THEN RETURN '{"error":"revoked"}'::jsonb; END IF;
  UPDATE pina_mcp.broker_state SET consumed=extract(epoch from now())::bigint WHERE kind=k AND id=i AND consumed IS NULL AND expires>extract(epoch from now());
  IF NOT FOUND THEN
   IF g IS NOT NULL THEN INSERT INTO pina_mcp.revoked_grants(id) VALUES(g) ON CONFLICT DO NOTHING; END IF;
   RETURN '{"error":"consumed"}'::jsonb;
  END IF;
 ELSIF op='destroy' THEN DELETE FROM pina_mcp.broker_state WHERE kind=k AND id=i;
 ELSE RETURN '{"error":"invalid_operation"}'::jsonb;
 END IF;
 RETURN '{}'::jsonb;
END $$;
ALTER TABLE pina_mcp.proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE pina_mcp.requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE pina_mcp.broker_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE pina_mcp.revoked_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON SCHEMA pina_mcp FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA pina_mcp FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pina_mcp FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.pina_mcp_dispatch(op text,p jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pina_mcp AS $$ SELECT pina_mcp.dispatch(op,p) $$;
CREATE FUNCTION public.pina_mcp_oauth_store(op text,p jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pina_mcp AS $$ SELECT pina_mcp.oauth_store(op,p) $$;
REVOKE ALL ON FUNCTION public.pina_mcp_dispatch(text,jsonb), public.pina_mcp_oauth_store(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pina_mcp_dispatch(text,jsonb), public.pina_mcp_oauth_store(text,jsonb) TO service_role;

COMMIT;
