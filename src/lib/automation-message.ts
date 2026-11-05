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
 * Makes an existing legacy JSON-quoted message safe to open and save without changing it.
 * New input is normalized once, on the server.
 */
export function automationMessageEditorValue(value: unknown): string {
	const text = String(value ?? '');
	return normalizeAutomationMessage(text) === text ? text : JSON.stringify(text);
}

/** Message pools still use one physical line per choice. A quoted JSON string can hold `\\n`. */
export function normalizeAutomationPool(value: unknown): string[] {
	return String(value ?? '')
		.split(/\r?\n/)
		.map(normalizeAutomationMessage);
}

/** Turns a stored pool back into one-choice-per-physical-line editor text. */
export function automationPoolEditorValue(values: readonly string[]): string {
	return values
		.map((value) => {
			const editorValue = automationMessageEditorValue(value);
			return /\r|\n/.test(editorValue) ? JSON.stringify(editorValue) : editorValue;
		})
		.join('\n');
}
