/**
 * @hazina/kit — Prompt-injection heuristics (OWASP LLM01).
 *
 * Covers direct jailbreaks, system-prompt extraction, role override,
 * tool-abuse instructions, and code-mixed (English/Swahili/Sheng) variants
 * (safety behaviour can differ across code-switched input — see eval set).
 */
export interface InjectionVerdict {
  flagged: boolean;
  score: number;
  signals: string[];
  action: "allow" | "sanitise" | "block";
}

interface Rule {
  name: string;
  weight: number;
  patterns: RegExp[];
}

const RULES: Rule[] = [
  {
    name: "instruction_override",
    weight: 0.6,
    patterns: [
      /\bignore\b[^\n]{0,40}\b(instructions|prompts|rules)\b/i,
      /\bdisregard\b[^\n]{0,40}\b(instructions|rules|guidelines)\b/i,
      /\b(puuza|puuzilia)\b[^\n]{0,30}\b(maagizo|instructions)\b/i,
      /\bweka kando maagizo\b/i,
    ],
  },
  {
    name: "role_override",
    weight: 0.55,
    patterns: [
      /you are now (a|an|the)? ?(different|new|jailbroken|DAN|unrestricted)/i,
      /act as (if you are )?(a|an)? ?(different persona|unrestricted|jailbroken)/i,
      /pretend (you are|to be) (a|an)? ?(different|unrestricted)/i,
      /jibu kama ungesimama kama mtu tofauti/i,
    ],
  },
  {
    name: "system_prompt_extraction",
    weight: 0.5,
    patterns: [
      /\b(reveal|show|print|repeat|leak|display|nipe)\b[^\n]{0,20}\b(your|the|yako)\b[^\n]{0,20}\b(prompt|instructions|maagizo|mfumo)\b/i,
      /\bwhat (are|is) your (system )?(prompt|instructions|rules)\b/i,
      /\beleza maagizo yako ya mfumo\b/i,
    ],
  },
  {
    name: "tool_abuse",
    weight: 0.7,
    patterns: [
      /(transfer|send) (money|pesa|kesho) (to|kwa) (myself|yourself|your account|mimi wewe)/i,
      /(bypass|skip|override) (the )?(approval|verification|otp|pin|limits?)/i,
      /rudi OTP tena bila/i,
      /ka izungushe approval/i,
    ],
  },
  {
    name: "data_exfiltration",
    weight: 0.65,
    patterns: [
      /\b(send|tuma|post|exfiltrate|leak|nipe|telezesha)\b[^\n]{0,40}\b(all|the|every|orodha)\b[^\n]{0,20}\b(customer|account|data|records|wateja|mateja)\b/i,
      /\b(download|dump)\b[^\n]{0,20}\b(the\s+)?(database|audit log|all records)\b/i,
      /\btuma orodha ya wateja\b/i,
    ],
  },
  {
    name: "confidentiality_probe",
    weight: 0.6,
    patterns: [
      /\b(salio|balance|taarifa|data|account)\b[^\n]{0,30}\b(mwingine|wa wengine|za wateja wengine)\b/i,
      /\banother\s+(user|customer)'?s?\s+(balance|account|data|statement)\b/i,
    ],
  },
  {
    name: "encoded_attack",
    weight: 0.4,
    patterns: [
      /base64:?[A-Za-z0-9+/=]{24,}/i,
      /\\x[0-9a-f]{2}(\\x[0-9a-f]{2}){8,}/i,
    ],
  },
  {
    name: "delimiter_smuggling",
    weight: 0.45,
    patterns: [
      /<\/?(system|assistant|tool|instructions)>/i,
      /\[SYSTEM\]|\[INST\]/i,
    ],
  },
];

export function detectInjection(text: string, threshold = 0.5): InjectionVerdict {
  const signals: string[] = [];
  let score = 0;
  for (const rule of RULES) {
    for (const p of rule.patterns) {
      if (p.test(text)) {
        signals.push(rule.name);
        score += rule.weight;
        break;
      }
    }
  }
  score = Math.min(1, score);
  const flagged = score >= threshold;
  return {
    flagged,
    score,
    signals,
    action: score >= 0.8 ? "block" : flagged ? "sanitise" : "allow",
  };
}

/** Wrap untrusted content (retrieved chunks, uploaded docs) in explicit delimiters. */
export function wrapUntrusted(content: string, label: string): string {
  const sanitised = content
    .replace(/<\/?(system|assistant|tool|instructions)>/gi, "[filtered-tag]")
    .replace(/\[SYSTEM\]|\[INST\]/gi, "[filtered-marker]");
  return `<untrusted_source label="${label}">\n${sanitised}\n</untrusted_source>`;
}
