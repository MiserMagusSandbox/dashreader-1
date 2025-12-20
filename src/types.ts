export interface DashReaderSettings {
  wpm: number;
  chunkSize: number;
  fontSize: number;
  highlightColor: string;
  backgroundColor: string;
  fontColor: string;
  fontFamily: string;
  showContext: boolean;
  showBreadcrumb: boolean;
  enableMicropause: boolean;
  micropausePunctuation: number;
  micropauseOtherPunctuation: number;
  micropauseLongWords: number;
  micropauseParagraph: number;
  micropauseNumbers: number;
  micropauseSectionMarkers: number;
  micropauseListBullets: number;
  micropauseCallouts: number;
  autoStart: boolean;
  autoStartDelay: number;
  showProgress: boolean;
  hotkeyPlay: string;
  hotkeyRewind: string;
  hotkeyForward: string;
  hotkeyIncrementWpm: string;
  hotkeyDecrementWpm: string;
  hotkeyQuit: string;
  enableSlowStart: boolean;
  enableAcceleration: boolean;
  accelerationDuration: number;
  accelerationTargetWpm: number;
  mobileFontSize: number;
  /** Minimum font size (px) when shrinking a single long token to fit */
  minTokenFontSize: number;
  mobileWpm: number;
  mobileChunkSize: number;
  mobileShowContext: boolean;
  mobileShowBreadcrumb: boolean;
  mobileEnableSlowStart: boolean;
  mobileEnableMicropause: boolean;
  // Context is now line-based:
  // 0 = only the anchor line (before/after on the current line)
  // 1..10 = that many full lines above + below, plus anchor lines
  contextLines: number;
  mobileContextLines: number;
  // Context font size (px), separate profiles
  contextFontSize: number;
  mobileContextFontSize: number;
}

export const DEFAULT_SETTINGS: DashReaderSettings = {
  wpm: 600, // Increased from 300 (inspired by Stutter: 400-800 range)
  chunkSize: 1,
  fontSize: 48,
  mobileFontSize: 32,
  minTokenFontSize: 12,
  mobileWpm: 600,
  mobileChunkSize: 1,
  mobileShowContext: false,
  mobileShowBreadcrumb: true,
  mobileEnableSlowStart: true,
  mobileEnableMicropause: true,
  contextLines: 0,
  mobileContextLines: 0,
  contextFontSize: 14,
  mobileContextFontSize: 14,
  highlightColor: '#4a9eff',
  backgroundColor: '#1e1e1e',
  fontColor: '#ffffff',
  fontFamily: 'inherit',
  showContext: false,
  showBreadcrumb: true,
  enableMicropause: true,
  micropausePunctuation: 2.5, // Sentence-ending punctuation (.,!?) - Stutter-inspired
  micropauseOtherPunctuation: 1.5, // Other punctuation (;:,) - lighter pause
  micropauseLongWords: 1.4, // Words >8 chars - Stutter-inspired
  micropauseParagraph: 2.5, // Paragraph breaks - better section separation
  micropauseNumbers: 1.8, // Numbers and dates - comprehension aid
  micropauseSectionMarkers: 2.0, // Section numbers (1., I., etc.)
  micropauseListBullets: 1.8, // List bullets (-, *, +, •)
  micropauseCallouts: 2.0, // Obsidian callouts
  autoStart: false,
  autoStartDelay: 3,
  showProgress: true,
  hotkeyPlay: 'Space',
  hotkeyRewind: 'ArrowLeft',
  hotkeyForward: 'ArrowRight',
  hotkeyIncrementWpm: 'ArrowUp',
  hotkeyDecrementWpm: 'ArrowDown',
  hotkeyQuit: 'Escape',
  enableSlowStart: true, // Enable slow start by default
  enableAcceleration: false,
  accelerationDuration: 30,
  accelerationTargetWpm: 600 // Increased from 450 (Stutter suggests 600-800)
};

export interface HeadingInfo {
  /** Heading level (1-6), or 0 for callouts */
  level: number;
  /** Heading text (without [H1] or [CALLOUT:type] marker) */
  text: string;
  /** Word index where this heading appears */
  wordIndex: number;
  /** Callout type if this is a callout (note, abstract, info, etc.) */
  calloutType?: string;
}

export interface HeadingContext {
  /** Breadcrumb path from H1 to current heading */
  breadcrumb: HeadingInfo[];
  /** Current heading (last item in breadcrumb) */
  current: HeadingInfo | null;
}

export interface WordChunk {
  text: string;
  index: number;
  delay: number;
  isEnd: boolean;
  /** Current heading context (breadcrumb) - optional */
  headingContext?: HeadingContext;
}

export interface ReadingStats {
  wordsRead: number;
  timeSpent: number;
  sessionsCount: number;
  averageWpm: number;
}
