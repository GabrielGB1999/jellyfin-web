import React, { type FC, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import Screenfull from 'screenfull';

import IconButton from '../../elements/emby-button/IconButton';
import globalize from 'lib/globalize';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client';

interface PdfOsdProps {
    item: BaseItemDto;
    onExit: () => void;
    onPrevious: () => void;
    onNext: () => void;
    onToggleFullscreen: () => void;
    /** Row rendered above the bottom toolbar, e.g. a page slider. */
    progressBar?: ReactNode;
    /** Controls rendered before the fullscreen button. */
    toolbarItems?: ReactNode;
}

/** On screen controls of the PDF reader, hidden after a short time without interaction. */
const PdfOsd: FC<PdfOsdProps> = ({
    item,
    onExit,
    onPrevious,
    onNext,
    onToggleFullscreen,
    progressBar,
    toolbarItems
}) => {
    const timeout = useRef<ReturnType<typeof setTimeout>>();

    const [fullscreen, setFullscreen] = useState(false);
    const [visible, setVisible] = useState(true);

    const scheduleHide = useCallback(() => {
        clearTimeout(timeout.current);
        timeout.current = setTimeout(() => setVisible(false), 2000);
    }, []);

    const updateFullscreen = useCallback((state: boolean) => {
        if (Screenfull.isEnabled && Screenfull.isFullscreen !== state) {
            void Screenfull.toggle();
        } else if (window.NativeShell) {
            if (state) {
                window.NativeShell.enableFullscreen();
            } else {
                window.NativeShell.disableFullscreen();
            }
        }
    }, []);

    const onClickFullscreen = useCallback(() => {
        updateFullscreen(!fullscreen);
        onToggleFullscreen();
        setFullscreen(state => !state);
    }, [onToggleFullscreen, updateFullscreen, fullscreen]);

    useEffect(() => {
        const onPointerMove = (event: PointerEvent) => {
            if (event.pointerType !== 'mouse') return;

            scheduleHide();
            setVisible(true);
        };

        const onClick = (event: MouseEvent) => {
            // apply this before the row check so button clicks will reset the timer
            scheduleHide();

            if ((event.target as Element | null)?.closest?.('.pdfOsdRow')) return;
            setVisible(state => !state);
        };

        scheduleHide();
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('click', onClick);

        return () => {
            clearTimeout(timeout.current);
            updateFullscreen(false);
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('click', onClick);
        };
    }, [scheduleHide, updateFullscreen]);

    const hiddenStyle = visible ? undefined : { opacity: 0, pointerEvents: 'none' as const };

    return (
        <div className='pdfOsd'>
            <div className='pdfOsdBar pdfOsdTop' style={hiddenStyle}>
                <div className='pdfOsdRow'>
                    <IconButton onClick={onExit} icon='arrow_back' title={globalize.translate('ButtonBack')} />
                    <span className='pdfOsdTitle'>{item.Name}</span>
                </div>
            </div>

            <div className='pdfOsdBar pdfOsdBottom' style={hiddenStyle}>
                {progressBar && (
                    <div className='pdfOsdRow pdfOsdProgressRow'>
                        {progressBar}
                    </div>
                )}

                <div className='pdfOsdRow'>
                    <IconButton onClick={onPrevious} icon='navigate_before' title={globalize.translate('Previous')} />
                    <IconButton onClick={onNext} icon='navigate_next' title={globalize.translate('Next')} />
                    <div className='pdfOsdSpacer' />

                    {toolbarItems}

                    {(Screenfull.isEnabled || window.NativeShell) && (
                        <IconButton
                            onClick={onClickFullscreen}
                            icon={fullscreen ? 'fullscreen_exit' : 'fullscreen'}
                            title={globalize.translate(fullscreen ? 'ExitFullscreen' : 'Fullscreen')}
                        />
                    )}
                </div>
            </div>
        </div>
    );
};

export default PdfOsd;
