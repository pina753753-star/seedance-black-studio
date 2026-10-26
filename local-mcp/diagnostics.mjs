// Only fixed categories cross this boundary. Never accept an exception, request,
// URL, identifier, or arbitrary metadata as log data.
const categories=new Set([
 'consent_session_failed','consent_details_missing','consent_details_failed',
 'consent_validation_failed','consent_body_failed','consent_csrf_failed',
 'consent_grant_save_failed','consent_finalize_missing','consent_finalize_failed','consent_response_failed',
 'oauth_store_read_failed','oauth_store_write_failed','oauth_store_rejected',
 'release_handler_failed',
]);
export function createDiagnosticReporter(sink=line=>console.error(line)){
 return category=>{if(!categories.has(category))return;try{sink(JSON.stringify({event:'pina_mcp_diagnostic',category}));}catch{/* Logging never changes an authorization decision. */}};
}
export const reportDiagnostic=createDiagnosticReporter();
