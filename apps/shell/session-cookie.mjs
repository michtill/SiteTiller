// Cookies are told apart by host, not by port: instances on one host with ports (local ones) each get their own
// session cookie name, so signing in to one does not sign out of another. A plain https origin keeps the base name.
export const sessionCookie = (editOrigin) =>
  'sitetiller_edit' + (new URL(editOrigin).port ? '_' + new URL(editOrigin).port : '');
