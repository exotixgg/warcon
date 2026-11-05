/**
 * A message may be pasted as a JSON string when it needs escaped line breaks.  Keeping this small
 * parser separate means ordinary messages (including literal `\\n`) remain exactly as authored.
 */
export function normalizeAutomationMessage(value: unknown): string {
	const text = String(value ?? '');
	const candidate = text.trim();
	if (!candidate.startsWith('"') || !candidate.endsWith('"')) return text;
	try {
		const parsed: unknown = JSON.parse(candidate);
		return typeof parsed === 'string' ? parsed : text;
	} catch {
		return text;
	}
}

/**
 * Makes multiline and legacy JSON-quoted messages safe even in single-line inputs.
 * New input is normalized once, on the server.
 */
export function automationMessageEditorValue(value: unknown): string {
	const text = String(value ?? '');
	return /\r|\n/.test(text) || normalizeAutomationMessage(text) !== text
		? JSON.stringify(text)
		: text;
}

/** Message pools still use one physical line per choice. A quoted JSON string can hold `\\n`. */
export function normalizeAutomationPool(value: unknown): string[] {
	return String(value ?? '')
		.split(/\r?\n/)
		.map(normalizeAutomationMessage);
}

/** Turns a stored pool back into one-choice-per-physical-line editor text. */
export function automationPoolEditorValue(values: readonly string[]): string {
	return values.map(automationMessageEditorValue).join('\n');
}
