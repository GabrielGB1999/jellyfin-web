import Slider from '@mui/material/Slider';
import React, { type FC, useCallback, useEffect, useMemo, useState } from 'react';

import actionsheet from '../../components/actionSheet/actionSheet';
import IconButton from '../../elements/emby-button/IconButton';
import globalize from 'lib/globalize';
import Events from '../../utils/events';

export type PdfViewMode = 'single' | 'spread' | 'continuous';

export interface PdfChapter {
    title: string;
    page: number;
    /** Nesting depth in the document outline, 0 for top level chapters. */
    level: number;
}

export interface PdfViewState {
    page: number;
    numPages: number;
    zoom: number;
    viewMode: PdfViewMode;
    /** Outline entries in document order, empty when the document has none. */
    chapters: PdfChapter[];
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

/** Returns the last chapter starting at or before the page. */
const getChapterAt = (chapters: PdfChapter[], page: number) => {
    let current: PdfChapter | undefined;
    for (const chapter of chapters) {
        if (chapter.page <= page && (!current || chapter.page >= current.page)) current = chapter;
    }
    return current;
};

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
    const { page, numPages, chapters } = useViewState(player);
    // Local value so dragging previews the page number without rendering every page on the way
    const [value, setValue] = useState<number | null>(null);

    const onChange = useCallback((_e: Event, newValue: number | number[]) => {
        setValue(newValue as number);
    }, []);

    const onChangeCommitted = useCallback((_e: React.SyntheticEvent | Event, newValue: number | number[]) => {
        setValue(null);
        player.seek(newValue as number);
    }, [player]);

    // Only top level chapters are marked, nested ones would crowd the slider
    const topChapters = useMemo(() => (
        chapters.filter(chapter => chapter.level === 0).sort((a, b) => a.page - b.page)
    ), [chapters]);
    const marks = useMemo(() => topChapters.map(chapter => ({ value: chapter.page })), [topChapters]);

    const formatValueLabel = useCallback((v: number) => {
        const pageLabel = globalize.translate('PageNumberOfTotal', v, numPages);
        const chapter = getChapterAt(chapters, v);
        return chapter ? `${chapter.title} · ${pageLabel}` : pageLabel;
    }, [chapters, numPages]);

    const current = value ?? page;

    // Highlight the range of the top level chapter being read, in the slider's percent scale
    let highlight;
    const chapter = getChapterAt(topChapters, current);
    if (chapter && numPages > 1) {
        const next = topChapters.find(c => c.page > chapter.page);
        const end = next ? next.page : numPages;
        highlight = {
            left: `${(chapter.page - 1) / (numPages - 1) * 100}%`,
            width: `${(end - chapter.page) / (numPages - 1) * 100}%`
        };
    }

    return (
        <>
            <div className='pdfPageSliderContainer'>
                {highlight && <span className='pdfChapterHighlight' style={highlight} />}
                <Slider
                    className='pdfPageSlider'
                    aria-label={globalize.translate('PageNumberOfTotal', current, numPages)}
                    min={1}
                    max={Math.max(numPages, 1)}
                    step={1}
                    value={current}
                    disabled={numPages <= 1}
                    valueLabelDisplay='auto'
                    valueLabelFormat={formatValueLabel}
                    onChange={onChange}
                    onChangeCommitted={onChangeCommitted}
                    marks={marks}
                />
            </div>
            <span className='pdfPageLabel'>{current} / {numPages}</span>
        </>
    );
};

interface ViewModeButtonProps {
    player: PdfControlsPlayer;
    mode: PdfViewMode;
    icon: string;
    title: string;
    active: boolean;
}

const ViewModeButton: FC<ViewModeButtonProps> = ({ player, mode, icon, title, active }) => {
    const onClick = useCallback(() => player.setViewMode(mode), [player, mode]);

    return (
        <IconButton
            className={active ? 'pdfViewModeActive' : undefined}
            onClick={onClick}
            icon={icon}
            title={globalize.translate(title)}
        />
    );
};

const ChaptersButton: FC<PdfControlsProps & { chapters: PdfChapter[], page: number }> = ({ player, chapters, page }) => {
    const onClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
        const current = getChapterAt(chapters, page);

        actionsheet.show({
            title: globalize.translate('TableOfContents'),
            items: chapters.map((chapter, index) => ({
                id: String(index),
                // em spaces survive HTML whitespace collapsing, so nested chapters stay indented
                name: '\u2003'.repeat(chapter.level) + chapter.title,
                asideText: String(chapter.page),
                selected: chapter === current
            })),
            positionTo: e.currentTarget
        }).then(id => {
            const chapter = chapters[Number(id)];
            if (chapter) player.seek(chapter.page);
        }).catch(() => { /* closed without choosing */ });
    }, [player, chapters, page]);

    return <IconButton onClick={onClick} icon='toc' title={globalize.translate('TableOfContents')} />;
};

/** Chapter, zoom and view mode buttons shown in the reader toolbar. */
export const PdfToolbar: FC<PdfControlsProps> = ({ player }) => {
    const { zoom, viewMode, chapters, page } = useViewState(player);

    return (
        <>
            {chapters.length > 0 && <ChaptersButton player={player} chapters={chapters} page={page} />}

            <IconButton className='pdfZoomButton' onClick={player.zoomOut} icon='zoom_out' title={globalize.translate('ZoomOut')} />
            <button
                type='button'
                className='pdfZoomLabel'
                onClick={player.resetZoom}
                title={globalize.translate('ZoomReset')}
            >
                {Math.round(zoom * 100)}%
            </button>
            <IconButton className='pdfZoomButton' onClick={player.zoomIn} icon='zoom_in' title={globalize.translate('ZoomIn')} />

            <div className='pdfToolbarDivider' />

            {VIEW_MODES.map(({ mode, icon, title }) => (
                <ViewModeButton
                    key={mode}
                    player={player}
                    mode={mode}
                    icon={icon}
                    title={title}
                    active={mode === viewMode}
                />
            ))}
        </>
    );
};
