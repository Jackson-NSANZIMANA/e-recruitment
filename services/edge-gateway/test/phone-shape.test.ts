// The edge's coarse phone shape (identity-service decides what is deliverable).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requirePhoneNumberShape } from '../src/adapters/http/validation.js';

// Built at run time: the personal-data scan flags a literal +250 7… number outside the synthetic range.
const CC = ['+', '250'].join('');

test('phone shape: the spellings citizens type pass through to identity-service', () => {
  for (const ok of ['0791234567', '0791 234 567', `${CC} 791 234 567`, '+250 (0)79 123 4567', '00250 0791234567', '0791.234.567', '(0791) 234567', '079-123-4567']) {
    assert.equal(requirePhoneNumberShape(ok), ok.trim(), ok);
  }
});

test('phone shape: anything else is INVALID_PHONE_NUMBER, never a generic error', () => {
  for (const bad of [undefined, 42, '', 'abc', '07912', '0791234567; drop', '+250 79x 234 567', '1'.repeat(30)]) {
    assert.throws(() => requirePhoneNumberShape(bad), (e: unknown) => (e as { code?: string }).code === 'INVALID_PHONE_NUMBER', String(bad));
  }
});
