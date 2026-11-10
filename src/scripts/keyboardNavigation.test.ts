import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    layoutManager: { tv: false },
    handleCommand: vi.fn()
}));

vi.mock('./inputManager', () => ({ default: { handleCommand: mocks.handleCommand } }));
vi.mock('../components/layoutManager', () => ({ default: mocks.layoutManager }));
vi.mock('./settings/appSettings', () => ({ default: { enableGamepad: () => false } }));

import { enable, keepsArrowKey } from './keyboardNavigation';

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

describe('arrow key handling', () => {
    const first = document.createElement('button');
    const second = document.createElement('button');
    const text = input('text');

    /** Presses a key on the focused element and returns _true_ if the browser default was prevented. */
    const press = (key: string, keyCode: number, options: KeyboardEventInit = {}) => {
        const event = new KeyboardEvent('keydown', { key, keyCode, bubbles: true, cancelable: true, ...options } as KeyboardEventInit);
        (document.activeElement ?? document.body).dispatchEvent(event);
        return event.defaultPrevented;
    };

    beforeAll(() => {
        document.body.append(first, second, text);
        enable();
    });

    beforeEach(() => {
        mocks.layoutManager.tv = false;
        mocks.handleCommand.mockReset();
        first.focus();
    });

    it('uses the key when focus moves', () => {
        mocks.handleCommand.mockImplementation(() => second.focus());

        expect(press('ArrowDown', 40)).toBe(true);
        expect(mocks.handleCommand).toHaveBeenCalledWith('down');
    });

    it('lets the browser scroll when focus does not move', () => {
        expect(press('ArrowDown', 40)).toBe(false);
        expect(mocks.handleCommand).toHaveBeenCalledWith('down');
    });

    it('navigates with Shift+arrows outside TV layout only', () => {
        mocks.handleCommand.mockImplementation(() => second.focus());
        expect(press('ArrowRight', 39, { shiftKey: true })).toBe(true);

        mocks.layoutManager.tv = true;
        first.focus();
        mocks.handleCommand.mockReset();
        expect(press('ArrowRight', 39, { shiftKey: true })).toBe(false);
        expect(mocks.handleCommand).not.toHaveBeenCalled();
    });

    it('keeps the TV layout behavior in text fields', () => {
        mocks.layoutManager.tv = true;
        text.focus();

        // up/down always leave the field, even if focus does not move
        expect(press('ArrowDown', 40)).toBe(true);
        expect(mocks.handleCommand).toHaveBeenCalledWith('down');

        // left/right move the caret
        mocks.handleCommand.mockReset();
        expect(press('ArrowLeft', 37)).toBe(false);
        expect(mocks.handleCommand).not.toHaveBeenCalled();
    });
});
