/**
 * Turns "no API key" from a dead end into an instruction.
 *
 * Testpilot needs a model provider credential, and there is no way around
 * that: the key belongs to the adopter's own account and billing
 * relationship, so nothing Testpilot installs can create one. What it *can*
 * do is fail in a way that says exactly what to set and where — the raw
 * provider error ("Could not find API key process.env.GROQ_API_KEY") is
 * accurate and completely unactionable to someone seeing it for the first
 * time in a pull-request comment.
 */

/**
 * Environment variable each provider's key is read from.
 *
 * Deliberately a small, known list rather than an exhaustive one. A model
 * string naming a provider that isn't here — a local endpoint, a
 * self-hosted gateway, something newer than this map — is treated as
 * "cannot check", never as "misconfigured". Guessing wrong in that
 * direction would nag a correctly-configured self-hosted setup on every
 * single run, which is precisely the audience this project claims to serve.
 */
const PROVIDER_ENV_VARS: Record<string, string> = {
  groq: 'GROQ_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  xai: 'XAI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
};

export interface CredentialStatus {
  /** Provider slug parsed from the model string, e.g. `groq`. */
  provider: string;
  /** The variable its key is read from, when this provider is a known one. */
  envVar?: string;
  /**
   * False only when the provider is known *and* its variable is missing.
   * An unrecognised provider is `true`: it may well be a local endpoint
   * that needs no key at all.
   */
  satisfied: boolean;
}

/** Providers are the segment before the first slash: `groq/openai/gpt-oss-120b` -> `groq`. */
export function providerOf(model: string): string {
  const slash = model.indexOf('/');
  return slash === -1 ? model : model.slice(0, slash);
}

export function checkModelCredentials(
  model: string,
  env: Record<string, string | undefined> = process.env,
): CredentialStatus {
  const provider = providerOf(model);
  const envVar = PROVIDER_ENV_VARS[provider];

  if (envVar === undefined) return { provider, satisfied: true };

  const value = env[envVar];
  return { provider, envVar, satisfied: value !== undefined && value.trim() !== '' };
}

/**
 * Any *other* known provider whose key is already configured.
 *
 * Worth checking before telling someone to go get a credential: supplying
 * an OpenAI key while leaving the model at its Groq default is an easy and
 * entirely reasonable mistake — the Action's own inputs invite it by
 * accepting either key — and the fix is one setting, not a signup.
 */
export function availableAlternativeProvider(
  exclude: string,
  env: Record<string, string | undefined> = process.env,
): { provider: string; envVar: string } | undefined {
  for (const [provider, envVar] of Object.entries(PROVIDER_ENV_VARS)) {
    if (provider === exclude) continue;
    const value = env[envVar];
    if (value !== undefined && value.trim() !== '') return { provider, envVar };
  }
  return undefined;
}

/**
 * The setup instructions for a missing credential, covering both places
 * someone runs Testpilot — a pull request and their own terminal.
 */
export function credentialGuidance(
  status: CredentialStatus,
  env: Record<string, string | undefined> = process.env,
): string {
  if (status.satisfied || !status.envVar) return '';

  // If they already hold a usable key for a different provider, the right
  // advice is "point the model at what you have", not "go create an account".
  const alternative = availableAlternativeProvider(status.provider, env);
  if (alternative) {
    return (
      `${status.envVar} is not set, but ${alternative.envVar} is. ` +
      `Testpilot is configured to use ${status.provider}, so the key you already have went unused. ` +
      `To use it, point \`TESTPILOT_MODEL\` at ${alternative.provider} ` +
      `(in the Action, the \`model:\` input) — or supply a ${status.provider} key as well.`
    );
  }

  const actionInput = `${status.provider}-api-key`;
  return (
    `${status.envVar} is not set, so Testpilot could not reach ${status.provider}. ` +
    `In GitHub Actions: run \`gh secret set ${status.envVar}\`, then pass it to the action as ` +
    `\`${actionInput}: \${{ secrets.${status.envVar} }}\`. ` +
    `Locally: add \`${status.envVar}=...\` to your .env. ` +
    'The key is yours and Testpilot cannot create one — this is a one-time setup per repository. ' +
    'To use a local or self-hosted model instead, point TESTPILOT_MODEL at it and no key is needed.'
  );
}

/** True when a failure looks like a credential problem rather than a genuine outage. */
export function looksLikeCredentialFailure(message: string): boolean {
  return /api key|unauthorized|401|authentication|invalid[_ -]?api[_ -]?key|forbidden|403/i.test(message);
}

/**
 * Builds the sentence that goes in the report when test selection fails,
 * appending setup instructions when the cause is a missing credential.
 * Anything else — a rate limit, an outage — is reported as-is, since
 * there's nothing for the reader to configure.
 */
export function explainSelectionFailure(errorMessage: string, model: string, env = process.env): string {
  const base = `Test selection failed, so every test is being run as a safety net. Cause: ${errorMessage}`;
  if (!looksLikeCredentialFailure(errorMessage)) return base;

  const status = checkModelCredentials(model, env);
  const guidance = credentialGuidance(status, env);
  return guidance ? `${base}\n\n  **Setup:** ${guidance}` : base;
}
