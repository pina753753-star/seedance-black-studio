/* Reference-video upload helper (Seedance dance panel and the motion tab).
   supabase-js sends a Blob/File as multipart form data and keeps the file's OWN type; the contentType option is
   ignored on that path. The private bucket only accepts the types it lists, so the type that goes on the wire must be
   the file's real one: a MOV stays video/quicktime (it is never relabelled as MP4 - the worker probes the bytes and
   normalizes to H.264 MP4 itself). Only a missing/unknown type is filled in from the extension. */
(function (root) {
  'use strict';
  var BY_EXTENSION = { mp4: 'video/mp4', mov: 'video/quicktime' };
  var ACCEPTED = ['video/mp4', 'video/quicktime'];

  function extensionOf(name) {
    var m = /[.]([a-z0-9]+)$/.exec(String(name || '').toLowerCase());
    return m ? m[1] : '';
  }

  // 'video/mp4' | 'video/quicktime' | '' (not an MP4/MOV by type or extension)
  function resolveContentType(file) {
    if (!file) return '';
    var type = String(file.type || '').toLowerCase();
    if (ACCEPTED.indexOf(type) >= 0) return type;
    return BY_EXTENSION[extensionOf(file.name)] || '';
  }

  // { contentType, body } or null. body is the original File when its type is already right, otherwise a File/Blob
  // over the same bytes carrying the resolved type.
  function prepare(file) {
    var contentType = resolveContentType(file);
    if (!contentType) return null;
    if (String(file.type || '').toLowerCase() === contentType) return { contentType: contentType, body: file };
    var body = typeof File === 'function'
      ? new File([file], file.name || 'reference', { type: contentType })
      : new Blob([file], { type: contentType });
    return { contentType: contentType, body: body };
  }

  var api = { resolveContentType: resolveContentType, prepare: prepare };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.flowvidReferenceVideoUpload = api;
})(typeof window !== 'undefined' ? window : null);
