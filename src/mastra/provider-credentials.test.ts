import { describe, expect, it } from 'vitest';

import {
  checkModelCredentials,
  credentialGuidance,
  explainSelectionFailure,
  looksLikeCredentialFailure,
  providerOf,
} from './provider-credentials.ts';

describe('providerOf', () => {
  it('takes the segment before the first slash', () => {
    expect(providerOf('groq/openai/gpt-oss-120b')).toBe('groq');
    expect(providerOf('openai/gpt-5.4-mini')).toBe('openai');
  });

  it('returns the whole string when there is no slash', () => {
    expect(providerOf('some-local-model')).toBe('some-local-model');
  });
});

describe('checkModelCredentials', () => {
  it('is satisfied when the provider key is present', () => {
    const status = checkModelCredentials('groq/openai/gpt-oss-120b', { GROQ_API_KEY: 'gsk_notreal' });
    expect(status).toEqual({ provider: 'groq', envVar: 'GROQ_API_KEY', satisfied: true });
  });

  it('is unsatisfied when the key is missing or blank', () => {
    expect(checkModelCredentials('groq/x', {}).satisfied).toBe(false);
    expect(checkModelCredentials('groq/x', { GROQ_API_KEY: '' }).satisfied).toBe(false);
    expect(checkModelCredentials('groq/x', { GROQ_API_KEY: '   ' }).satisfied).toBe(false);
  });

  it('maps each known provider to its own variable', () => {
    expect(checkModelCredentials('openai/gpt-5.4-mini', {}).envVar).toBe('OPENAI_API_KEY');
    expect(checkModelCredentials('anthropic/claude', {}).envVar).toBe('ANTHROPIC_API_KEY');
  });

  it('treats an unknown provider as satisfied rather than misconfigured', () => {
    // Self-hosting is a first-class use case here. Warning about a missing
    // key on every run of a correctly-configured local model would nag
    // exactly the audience this project claims to serve.
    const status = checkModelCredentials('http://localhost:11434/llama3', {});
    expect(status.satisfied).toBe(true);
    expect(status.envVar).toBeUndefined();
  });
});

describe('credentialGuidance', () => {
  it('names the variable, the CI step, and the local step', () => {
    const guidance = credentialGuidance(checkModelCredentials('groq/x', {}));
    expect(guidance).toContain('GROQ_API_KEY');
    expect(guidance).toContain('gh secret set GROQ_API_KEY');
    expect(guidance).toContain('groq-api-key');
    expect(guidance).toContain('.env');
    // The point a first-time reader most needs: this is theirs to do once.
    expect(guidance).toContain('one-time setup');
  });

  it('says nothing when the credential is fine', () => {
    expect(credentialGuidance(checkModelCredentials('groq/x', { GROQ_API_KEY: 'k' }))).toBe('');
  });
});

describe('looksLikeCredentialFailure', () => {
  it('recognises the ways providers phrase an auth problem', () => {
    for (const message of [
      'Could not find API key process.env.GROQ_API_KEY for model id groq/openai/gpt-oss-120b',
      'Request failed with status 401',
      'Unauthorized',
      'invalid_api_key',
      '403 Forbidden',
    ]) {
      expect(looksLikeCredentialFailure(message), message).toBe(true);
    }
  });

  it('does not mistake a rate limit or an outage for one', () => {
    for (const message of [
      'Request too large for model on tokens per minute (TPM): Limit 8000, Requested 9081',
      'socket hang up',
      'Service Unavailable',
    ]) {
      expect(looksLikeCredentialFailure(message), message).toBe(false);
    }
  });
});

describe('explainSelectionFailure', () => {
  it('appends setup steps when the cause is a missing key', () => {
    const explanation = explainSelectionFailure(
      'Could not find API key process.env.GROQ_API_KEY',
      'groq/openai/gpt-oss-120b',
      {},
    );
    expect(explanation).toContain('being run as a safety net');
    expect(explanation).toContain('**Setup:**');
    expect(explanation).toContain('gh secret set GROQ_API_KEY');
  });

  it('reports a rate limit as-is, since there is nothing to configure', () => {
    const message = 'Request too large for model on tokens per minute (TPM): Limit 8000';
    const explanation = explainSelectionFailure(message, 'groq/openai/gpt-oss-120b', {});
    expect(explanation).toContain(message);
    expect(explanation).not.toContain('**Setup:**');
  });

  it('does not offer setup steps when the key is actually present', () => {
    // An auth-shaped error with the key set means the key is wrong, not
    // absent — telling someone to set a variable they already set is noise.
    const explanation = explainSelectionFailure('401 Unauthorized', 'groq/x', { GROQ_API_KEY: 'set-but-wrong' });
    expect(explanation).not.toContain('**Setup:**');
  });
});
