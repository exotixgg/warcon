import { describe, expect, test } from 'bun:test';
import {
	automationPoolEditorValue,
	automationMessageEditorValue,
	normalizeAutomationMessage,
	normalizeAutomationPool
} from './automation-message';

describe('automation message input', () => {
	test('decodes a JSON string with escaped line breaks', () => {
		expect(normalizeAutomationMessage('"Welcome\\n{player}"')).toBe('Welcome\n{player}');
	});

	test('leaves ordinary input and malformed JSON alone', () => {
		expect(normalizeAutomationMessage('Welcome \\n literally')).toBe('Welcome \\n literally');
		expect(normalizeAutomationMessage('"Welcome')).toBe('"Welcome');
	});

	test('keeps each message-pool line independent', () => {
		expect(normalizeAutomationPool('"One\\nTwo"\nThree')).toEqual(['One\nTwo', 'Three']);
	});

	test('serializes multiline pool entries as one JSON-quoted editor line', () => {
		expect(automationPoolEditorValue(['One\nTwo', 'Three'])).toBe('"One\\nTwo"\nThree');
	});

	test('reopening a multiline message in a single-line input preserves its line breaks', () => {
		const stored = 'One\nTwo';
		const input = automationMessageEditorValue(stored);
		expect(input.includes('\n')).toBe(false);
		expect(normalizeAutomationMessage(input)).toBe(stored);
	});

	test('keeps a legacy JSON-quoted message stable when reopening the editor', () => {
		expect(automationMessageEditorValue('"Welcome\\n{player}"')).toBe(
			'"\\\"Welcome\\\\n{player}\\\""'
		);
		expect(automationPoolEditorValue(['"One\\nTwo"'])).toBe('"\\\"One\\\\nTwo\\\""');
	});
});
