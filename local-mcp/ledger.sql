-- LOCAL ONLY. Dedicated empty test database; never a production migration.
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
-- Invoker rights; no public/authenticated execution or access. The local test
-- process is the sole DB owner. Production role/RLS review is a separate gate.
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
