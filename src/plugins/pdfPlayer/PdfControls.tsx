import Slider from '@mui/material/Slider';
import React, { type FC, useCallback, useEffect, useState } from 'react';

import IconButton from '../../elements/emby-button/IconButton';
import globalize from 'lib/globalize';
import Events from '../../utils/events';

export type PdfViewMode = 'single' | 'spread' | 'continuous';

export interface PdfViewState {
    page: number;
    numPages: number;
    zoom: number;
    viewMode: PdfViewMode;
}

/** The subset of the PDF player used by the controls. */
export interface PdfControlsPlayer {
    getViewState: () => PdfViewState;
    seek: (page: number) => void;
    zoomIn: () => void;
    zoomOut: () => void;
    resetZoom: () => void;
    setViewMode: (mode: PdfViewMode) => void;
}

interface PdfControlsProps {
    player: PdfControlsPlayer;
}

const VIEW_MODES: { mode: PdfViewMode, icon: string, title: string }[] = [
    { mode: 'single', icon: 'crop_portrait', title: 'ViewSinglePage' },
    { mode: 'spread', icon: 'import_contacts', title: 'ViewDoublePage' },
    { mode: 'continuous', icon: 'view_day', title: 'ViewContinuous' }
];

const useViewState = (player: PdfControlsPlayer) => {
    const [state, setState] = useState(() => player.getViewState());

    useEffect(() => {
        const onChange = () => setState(player.getViewState());

        Events.on(player, 'viewstatechange', onChange);
        onChange();

        return () => Events.off(player, 'viewstatechange', onChange);
    }, [player]);

    return state;
};

/** Page slider shown above the reader toolbar. */
export const PdfPageSlider: FC<PdfControlsProps> = ({ player }) => {
    const { page, numPages } = useViewState(player);
    // Local value so dragging previews the page number without rendering every page on the way
    const [value, setValue] = useState<number | null>(null);

    const onChange = useCallback((_e: Event, newValue: number | number[]) => {
        setValue(newValue as number);
    }, []);

    const onChangeCommitted = useCallback((_e: React.SyntheticEvent | Event, newValue: number | number[]) => {
        setValue(null);
        player.seek(newValue as number);
    }, [player]);

    const current = value ?? page;

    return (
        <>
            <Slider
                className='pdfPageSlider'
                aria-label={globalize.translate('PageNumberOfTotal', current, numPages)}
                min={1}
                max={Math.max(numPages, 1)}
                step={1}
                value={current}
                disabled={numPages <= 1}
                valueLabelDisplay='auto'
                valueLabelFormat={v => globalize.translate('PageNumberOfTotal', v, numPages)}
                onChange={onChange}
                onChangeCommitted={onChangeCommitted}
            />
            <span className='pdfPageLabel'>{current} / {numPages}</span>
        </>
    );
};

/** Zoom and view mode buttons shown in the reader toolbar. */
export const PdfToolbar: FC<PdfControlsProps> = ({ player }) => {
    const { zoom, viewMode } = useViewState(player);

    return (
        <>
            <IconButton onClick={player.zoomOut} icon='zoom_out' title={globalize.translate('ZoomOut')} />
            <button
                type='button'
                className='pdfZoomLabel'
                onClick={player.resetZoom}
                title={globalize.translate('ZoomReset')}
            >
                {Math.round(zoom * 100)}%
            </button>
            <IconButton onClick={player.zoomIn} icon='zoom_in' title={globalize.translate('ZoomIn')} />

            <div className='pdfToolbarDivider' />

            {VIEW_MODES.map(({ mode, icon, title }) => (
                <IconButton
                    key={mode}
                    className={mode === viewMode ? 'pdfViewModeActive' : undefined}
                    onClick={() => player.setViewMode(mode)}
                    icon={icon}
                    title={globalize.translate(title)}
                />
            ))}
        </>
    );
};
