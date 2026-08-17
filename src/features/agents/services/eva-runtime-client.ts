import {
  EvaContractV1InputSchema,
  EvaContractV1OutputSchema,
  type EvaContractV1Input,
  type EvaContractV1Output,
} from "../contracts/eva-contract-v1";

export const EVA_RUNTIME_TIMEOUT_MS = 15_000;

export interface EvaRuntimeContext {
  normalized_phone: string;
  mode: "shadow";
}

export interface EvaRuntimeEnvelope {
  contract: EvaContractV1Input;
  runtime_context: EvaRuntimeContext;
}

type EnvMap = Record<string, string | undefined>;

export interface InvokeEvaRuntimeOpts {
  contract: EvaContractV1Input;
  normalizedPhone: string;
  env?: EnvMap;
  fetchFn?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  timeoutMs?: number;
}

function readEnv(env: EnvMap | undefined, key: string): string {
  const value = (env ?? process.env)[key];
  return typeof value === "string" ? value.trim() : "";
}

export function buildEvaRuntimeEnvelope(
  contract: EvaContractV1Input,
  runtimeContext: { normalized_phone: string },
): EvaRuntimeEnvelope {
  const parsed = EvaContractV1InputSchema.safeParse(contract);
  if (!parsed.success) {
    throw new Error(
      `[eva-runtime-client] fail closed: invalid Eva input: ${parsed.error.message}`,
    );
  }

  const phone = runtimeContext.normalized_phone.trim();
  if (!phone) {
    throw new Error(
      "[eva-runtime-client] fail closed: normalized_phone is required",
    );
  }

  return {
    contract: parsed.data,
    runtime_context: {
      normalized_phone: phone,
      mode: "shadow",
    },
  };
}

export async function invokeEvaRuntime(
  opts: InvokeEvaRuntimeOpts,
): Promise<EvaContractV1Output> {
  const env = opts.env ?? process.env;
  const url = readEnv(env, "EVA_RUNTIME_URL");
  const token = readEnv(env, "EVA_RUNTIME_TOKEN");

  if (!url || !token) {
    throw new Error(
      "[eva-runtime-client] fail closed: EVA_RUNTIME_URL and EVA_RUNTIME_TOKEN are required",
    );
  }

  const envelope = buildEvaRuntimeEnvelope(opts.contract, {
    normalized_phone: opts.normalizedPhone,
  });

  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? EVA_RUNTIME_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[eva-runtime-client] fail closed: runtime request failed: ${message}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(
      `[eva-runtime-client] fail closed: runtime HTTP ${response.status}`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(
      "[eva-runtime-client] fail closed: runtime response is not JSON",
    );
  }

  const parsed = EvaContractV1OutputSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `[eva-runtime-client] fail closed: invalid Eva output: ${parsed.error.message}`,
    );
  }

  return parsed.data;
}
