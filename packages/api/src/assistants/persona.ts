/** Bound owner memory injected into the runtime prompt. */
export const PERSONALITY_INJECT_CAP = 500;

export function personaPrefixText(personality: string): string {
  const capped = personality.slice(0, PERSONALITY_INJECT_CAP).trim();
  return capped ? `${capped}\n\n` : "";
}
