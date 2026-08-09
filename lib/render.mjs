// Renders the browser-facing JavaScript payload.
//
// Everything interpolated goes through JSON.stringify. The original built the
// error branch with hand-rolled quote escaping inside a template literal, so a
// message containing a backtick or `${` emitted broken JavaScript.

/**
 * Make a JSON string safe to embed inside a <script> block.
 * JSON.stringify alone is not enough: `</script` closes the tag early, and
 * U+2028/U+2029 are literal line terminators in JavaScript source.
 */
function embedJson(value) {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

export function renderSuccess(data, meta = {}) {
    // Deliberately derived from the payload, never from `now`. A per-request
    // timestamp changes the body on every origin hit, churning the ETag and
    // defeating conditional revalidation for identical cached data.
    return `// Generated ${meta.generatedAt ?? 'unknown'}
(function () {
  window.publicationsData = ${embedJson(data)};
  window.publicationsMeta = ${embedJson(meta)};
  if (typeof window.onPublicationsLoaded === 'function') {
    window.onPublicationsLoaded(window.publicationsData);
  }
})();
`;
}

export function renderError(message) {
    return `(function () {
  var details = ${embedJson(String(message))};
  console.error('Error fetching publications data from server: ' + details);
  window.publicationsData = { error: 'Failed to load publications.', details: details };
  if (typeof window.onPublicationsLoaded === 'function') {
    window.onPublicationsLoaded(window.publicationsData);
  }
})();
`;
}
