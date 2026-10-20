import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionCookie } from '../apps/shell/session-cookie.mjs';
test('SH-01: instances on one host with different ports keep separate sign-ins; a plain https origin keeps the base name', () => {
  assert.equal(sessionCookie('http://127.0.0.1:4540'), 'sitetiller_edit_4540');
  assert.notEqual(sessionCookie('http://127.0.0.1:4540'), sessionCookie('http://127.0.0.1:4640'));
  assert.equal(sessionCookie('https://edit.example.cz'), 'sitetiller_edit');
});
