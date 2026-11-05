import { describe, expect, it, vi } from 'vitest';

vi.mock('./inputManager', () => ({ default: {} }));
vi.mock('../components/layoutManager', () => ({ default: {} }));
vi.mock('./settings/appSettings', () => ({ default: { enableGamepad: () => false } }));

import { keepsArrowKey } from './keyboardNavigation';

const input = (type: string) => Object.assign(document.createElement('input'), { type });

describe('keepsArrowKey', () => {
    it('lets single-line text fields give up/down to navigation', () => {
        expect(keepsArrowKey(input('text'), 'left', false)).toBe(true);
        expect(keepsArrowKey(input('search'), 'down', false)).toBe(false);
        expect(keepsArrowKey(input('text'), 'down', true)).toBe(true);
    });

    it('keeps every arrow in text areas', () => {
        expect(keepsArrowKey(document.createElement('textarea'), 'down', false)).toBe(true);
        expect(keepsArrowKey(document.createElement('textarea'), 'down', true)).toBe(true);
    });

    it('lets Shift+arrows leave value widgets', () => {
        for (const elem of [document.createElement('select'), input('range'), input('number')]) {
            expect(keepsArrowKey(elem, 'up', false)).toBe(true);
            expect(keepsArrowKey(elem, 'up', true)).toBe(false);
        }
    });

    it('never keeps arrows on buttons and links', () => {
        expect(keepsArrowKey(document.createElement('button'), 'left', false)).toBe(false);
        expect(keepsArrowKey(input('checkbox'), 'down', false)).toBe(false);
        expect(keepsArrowKey(null, 'down', false)).toBe(false);
    });
});
