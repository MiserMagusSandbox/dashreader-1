import { DashReaderSettings, WordChunk, HeadingInfo, HeadingContext } from './types';
import { TimeoutManager } from './services/timeout-manager';
import { MicropauseService } from './services/micropause-service';
type HistoryEntry = { index: number; tMs: number };

export class RSVPEngine {
  private words: string[] = [];
  private currentIndex: number = 0;
  private isPlaying: boolean = false;
  private timer: number | null = null;
  private settings: DashReaderSettings;
  private timeoutManager: TimeoutManager;
  private micropauseService: MicropauseService;
  private onWordChange: (chunk: WordChunk) => void;
  private startTime: number = 0;
  private startWpm: number = 0;
  private pausedTime: number = 0;
  private lastPauseTime: number = 0;
  private headings: HeadingInfo[] = [];
  private wordsReadInSession: number = 0;
    // virtual-time history for time-based rewind/forward
  private history: HistoryEntry[] = [];
  private historyCursor: number = -1;
  private playbackMs: number = 0;
  private virtualTimeAtIndexMs: number[] = [];
  private virtualTotalMs: number = 0;

  private tickGen = 0;
  private nextDueMs: number | null = null;

  private static readonly MAX_HISTORY_MS = 10 * 60_000;     // keep ~10 minutes
  private static readonly MAX_HISTORY_ENTRIES = 20_000;     // safety cap
  private useMobileProfile = false;

  private nowMs(): number {
    // performance.now() is monotonic and better for scheduling; fall back to Date.now().
    return (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
  }

  constructor(
    settings: DashReaderSettings,
    onWordChange: (chunk: WordChunk) => void,
    timeoutManager: TimeoutManager
  ) {
    this.settings = settings;
    this.onWordChange = onWordChange;
    this.timeoutManager = timeoutManager;
    this.micropauseService = new MicropauseService(settings, this.getEnableMicropauseSetting());
  }

  setText(text: string, startPosition?: number, startWordIndex?: number): void {
    // Nettoyer et diviser le texte en mots
    // Important: preserve line breaks by replacing them with a marker FIRST
    const cleaned = text
      .replace(/\n+/g, ' §§LINEBREAK§§ ')  // Replace line breaks FIRST
      .replace(/[ \t]+/g, ' ')              // Then clean up spaces/tabs (NOT \n!)
      .trim();

    this.words = cleaned.split(/\s+/);

    // Extraire les headings avec leur position (before replacing markers)
    this.extractHeadings();

    // Replace line break markers with actual line breaks for display
    this.words = this.words.map(word =>
      word === '§§LINEBREAK§§' ? '\n' : word
    );

    this.rebuildVirtualTimeline();

    // Utiliser l'index du mot si fourni (prioritaire)
    if (startWordIndex !== undefined) {
      this.currentIndex = Math.max(0, Math.min(startWordIndex, this.words.length - 1));
    } else if (startPosition !== undefined && startPosition > 0) {
      // Fallback: calculer depuis la position (deprecated)
      const textUpToCursor = text.substring(0, startPosition);
      const wordsBeforeCursor = textUpToCursor.trim().split(/\s+/).length;
      this.currentIndex = Math.min(wordsBeforeCursor, this.words.length - 1);
    } else {
      this.currentIndex = 0;
    }
    this.resetHistory();
    this.seedHistoryAtCurrentIndex(); // anchor playbackMs to this index's virtual time
  }

  setUseMobileProfile(useMobile: boolean): void {
    this.useMobileProfile = useMobile;
    this.micropauseService.updateSettings(this.settings, this.getEnableMicropauseSetting());
    this.rebuildVirtualTimeline();
  }

  play(): void {
    if (this.isPlaying) return;
    if (this.currentIndex >= this.words.length) {
      this.currentIndex = 0;
    }
    this.tickGen += 1;
    this.isPlaying = true;
    this.nextDueMs = null; // reset schedule anchor on every play/resume

    // Initialiser le temps de début et le WPM de départ
    if (this.startTime === 0) {
      this.startTime = Date.now();
      this.startWpm = this.getWpmSetting();
      this.wordsReadInSession = 0; // Reset slow start counter
    } else if (this.lastPauseTime > 0) {
      // Si on reprend après une pause, ajouter le temps de pause
      this.pausedTime += Date.now() - this.lastPauseTime;
      this.lastPauseTime = 0;
    }

    this.displayNextWord();
  }

  pause(): void {
    this.tickGen += 1;
    this.isPlaying = false;
    if (this.timer !== null) {
      this.timeoutManager.clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextDueMs = null;
    // Enregistrer le moment de la pause
    this.lastPauseTime = Date.now();
  }

  stop(): void {
    this.pause();
    this.nextDueMs = null;
    this.currentIndex = 0;
    // Réinitialiser les temps
    this.startTime = 0;
    this.pausedTime = 0;
    this.lastPauseTime = 0;
    this.startWpm = 0;
    this.wordsReadInSession = 0; // Reset slow start counter
    this.resetHistory();
  }

  reset(): void {
    this.stop();
  }

  private resetHistory(): void {
    this.history = [];
    this.historyCursor = -1;
    this.playbackMs = 0;
  }

  private getWpmAtElapsedSeconds(elapsedSec: number): number {
    if (!this.settings.enableAcceleration) return this.getWpmSetting();

    const startWpm = this.getWpmSetting(); // same as play() initial startWpm for deterministic model
    const target = this.settings.accelerationTargetWpm;
    const dur = Math.max(1, this.settings.accelerationDuration);

    if (elapsedSec >= dur) return Math.round(target);

    const progress = elapsedSec / dur;
    return Math.round(startWpm + (target - startWpm) * progress);
  }

  private rebuildVirtualTimeline(): void {
    const n = this.words.length;
    this.virtualTimeAtIndexMs = new Array(n).fill(0);
    this.virtualTotalMs = 0;
    if (n === 0) return;

    let tMs = 0;
    let sessionCount = 0;
    const SLOW_START_WORDS = 5;

    for (let i = 0; i < n; i++) {
      // record time-at-index even for linebreaks (they map to nearest time)
      this.virtualTimeAtIndexMs[i] = tMs;

      const w = this.words[i];
      if (w === '\n') continue; // playback skips these with 0 delay

      // virtual WPM from virtual time, not Date.now()
      const wpm = this.getWpmAtElapsedSeconds(tMs / 1000);
      const baseDelay = (60 / wpm) * 1000;

      let delayToken = w;

      // mirror getChunk(): paragraph pause applies to the word before '\n'
      if (i + 1 < n && this.words[i + 1] === '\n') {
        delayToken += '\n';
      }
      
      const mult = this.micropauseService.calculateMultiplier(delayToken);

      let delay = baseDelay * mult;

      if (this.getEnableSlowStartSetting() && sessionCount < SLOW_START_WORDS) {
        const remainingSlowWords = SLOW_START_WORDS - sessionCount;
        const slowStartMultiplier = 1 + (remainingSlowWords / SLOW_START_WORDS);
        delay *= slowStartMultiplier;
      }

      sessionCount += 1;
      tMs += Math.max(0, delay);
    }

    this.virtualTotalMs = tMs;
  }

  private recordHistory(index: number, delayMs: number): void {
    // If user rewound and then resumes reading, discard "future" history.
    if (this.historyCursor < this.history.length - 1) {
      this.history = this.history.slice(0, this.historyCursor + 1);
    }

    // If the last entry is exactly this same moment/index (e.g. after a seek anchor),
    // don't add a duplicate. Just advance time by delay.
    const last = this.history[this.history.length - 1];
    if (last && last.index === index && last.tMs === this.playbackMs) {
      this.playbackMs += Math.max(0, delayMs);
      return;
    }

    // tMs = time at which this word was displayed (virtual reading time)
    this.history.push({ index, tMs: this.playbackMs });
    this.historyCursor = this.history.length - 1;

    this.playbackMs += Math.max(0, delayMs);

    // Trim old history window
    while (
      this.history.length > RSVPEngine.MAX_HISTORY_ENTRIES ||
      (this.history.length > 0 && this.playbackMs - this.history[0].tMs > RSVPEngine.MAX_HISTORY_MS)
    ) {
      this.history.shift();
      this.historyCursor -= 1;
    }
    if (this.historyCursor < -1) this.historyCursor = -1;
  }

  private getCursorTimeMs(): number {
    if (this.history.length === 0 || this.historyCursor < 0) return 0;
    return this.history[this.historyCursor].tMs;
  }

  private findLastAtOrBefore(tMs: number): number {
    if (this.history.length === 0) return -1;
    let lo = 0, hi = this.history.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.history[mid].tMs <= tMs) { ans = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    return ans;
  }

  private findFirstAtOrAfter(tMs: number): number {
    if (this.history.length === 0) return -1;
    let lo = 0, hi = this.history.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.history[mid].tMs >= tMs) { ans = mid; hi = mid - 1; }
      else { lo = mid + 1; }
    }
    return ans;
  }

  private seekToHistoryCursor(cursor: number): void {
    if (cursor < 0 || cursor >= this.history.length) return;
    this.historyCursor = cursor;
    this.currentIndex = this.history[cursor].index;
    this.playbackMs = this.history[cursor].tMs;
  }

  private isSentenceBoundaryToken(word: string): boolean {
    if (!word) return false;
    if (word === '\n') return true;
    if (/^\[H\d\]/.test(word) || /^\[CALLOUT:/.test(word)) return true;
    return /[.!?]["')\]]?$/.test(word);
  }

  private alignToSentenceStart(index: number): number {
    let i = Math.max(0, Math.min(index, this.words.length - 1));
    while (i > 0 && !this.isSentenceBoundaryToken(this.words[i - 1])) i -= 1;
    while (i < this.words.length && this.words[i] === '\n') i += 1;
    return i;
  }

  rewind(steps: number = 20): void {
    this.moveByWords(-steps);
    if (this.isPlaying) {
      this.pause();
      this.play();
    } else {
      this.displayCurrentWord();
    }
  }

  forward(steps: number = 20): void {
    this.moveByWords(steps);
    if (this.isPlaying) {
      this.pause();
      this.play();
    } else {
      this.displayCurrentWord();
    }
  }

  private moveByWords(wordDelta: number): void {
    if (this.words.length === 0 || wordDelta === 0) return;

    let i = this.currentIndex;

    // If we're sitting on a linebreak, normalize first:
    if (wordDelta < 0) {
      while (i > 0 && this.words[i] === '\n') i -= 1;
    } else {
      while (i < this.words.length && this.words[i] === '\n') i += 1;
    }

    let remaining = Math.abs(wordDelta);

    if (wordDelta < 0) {
      // Move backward counting only non-linebreak tokens
      while (i > 0 && remaining > 0) {
        i -= 1;
        if (this.words[i] !== '\n') remaining -= 1;
      }
      // Ensure we don't end on a linebreak
      while (i > 0 && this.words[i] === '\n') i -= 1;
    } else {
      // Move forward counting only non-linebreak tokens
      while (i < this.words.length - 1 && remaining > 0) {
        i += 1;
        if (this.words[i] !== '\n') remaining -= 1;
      }
      // Ensure we don't end on a linebreak
      while (i < this.words.length - 1 && this.words[i] === '\n') i += 1;
    }

    this.currentIndex = Math.max(0, Math.min(i, this.words.length - 1));
  }

  rewindSeconds(seconds: number = 10, snapToSentence: boolean = false): void {
    const wasPlaying = this.isPlaying;
    if (wasPlaying) this.pause();

    const curMs =
      (this.history.length > 0 && this.historyCursor >= 0)
        ? this.history[this.historyCursor].tMs
        : (this.virtualTimeAtIndexMs[this.currentIndex] ?? 0);

    const targetMs = Math.max(0, curMs - seconds * 1000);

    const canUseHistory =
      this.history.length >= 2 &&
      this.historyCursor >= 0 &&
      this.history[0].tMs <= targetMs;

    // If history can’t reach the target (common right after heading jumps), use the virtual timeline.
    if (!canUseHistory) {
      this.currentIndex = this.findVirtualIndexAtOrBeforeMs(targetMs);
      if (snapToSentence) this.currentIndex = this.alignToSentenceStart(this.currentIndex);

      this.resetHistory();
      this.seedHistoryAtCurrentIndex();

      if (wasPlaying) this.play();
      else this.displayCurrentWord();
      return;
    }

    const cursor = this.findLastAtOrBefore(targetMs);
    if (cursor === -1) {
      // Defensive fallback (shouldn’t happen if canUseHistory is true)
      this.currentIndex = this.findVirtualIndexAtOrBeforeMs(targetMs);
      if (snapToSentence) this.currentIndex = this.alignToSentenceStart(this.currentIndex);

      this.resetHistory();
      this.seedHistoryAtCurrentIndex();

      if (wasPlaying) this.play();
      else this.displayCurrentWord();
      return;
    }

    this.seekToHistoryCursor(cursor);

    if (snapToSentence) {
      const aligned = this.alignToSentenceStart(this.currentIndex);

      // If sentence alignment goes earlier than our recorded window, fall back cleanly.
      if (this.history.length > 0 && aligned < this.history[0].index) {
        this.currentIndex = aligned;
        this.resetHistory();
        this.seedHistoryAtCurrentIndex();
      } else {
        while (this.historyCursor > 0 && this.history[this.historyCursor].index > aligned) {
          this.historyCursor -= 1;
        }
        this.currentIndex = aligned;
        this.playbackMs = this.history[this.historyCursor]?.tMs ?? (this.virtualTimeAtIndexMs[this.currentIndex] ?? 0);
      }
    }

    if (wasPlaying) this.play();
    else this.displayCurrentWord();
  }

  forwardSeconds(seconds: number = 10): void {
    const wasPlaying = this.isPlaying;
    if (wasPlaying) this.pause();

    // If history is empty/too short (e.g. just jumped), seek via the virtual timeline.
    if (this.history.length < 2) {
      const curMs = this.virtualTimeAtIndexMs[this.currentIndex] ?? 0;
      const targetMs = curMs + seconds * 1000;
      this.currentIndex = this.findVirtualIndexAtOrAfterMs(targetMs);
    
      this.resetHistory();
      this.seedHistoryAtCurrentIndex();

      if (wasPlaying) this.play();
      else this.displayCurrentWord();
      return;
    }

    // If we rewound into the past, move forward within recorded history (undo seek)
    if (this.history.length > 0 && this.historyCursor >= 0 && this.historyCursor < this.history.length - 1) {
      const target = this.getCursorTimeMs() + seconds * 1000;
      const nextCursor = this.findFirstAtOrAfter(target);
      this.seekToHistoryCursor(nextCursor !== -1 ? nextCursor : this.history.length - 1);

      if (wasPlaying) this.play();
      else this.displayCurrentWord();
      return;
    }

    // Otherwise simulate forward using the same delay rules (micropause + accel + slow start)
    let acc = 0;
    let i = this.currentIndex;
    let sessionCount = this.wordsReadInSession;
    const SLOW_START_WORDS = 5;

    while (i < this.words.length && acc < seconds * 1000) {
      if (this.words[i] === '\n') { i += 1; continue; }

      let delay = this.getChunk(i).delay;

      if (this.getEnableSlowStartSetting() && sessionCount < SLOW_START_WORDS) {
        const remainingSlowWords = SLOW_START_WORDS - sessionCount;
        const slowStartMultiplier = 1 + (remainingSlowWords / SLOW_START_WORDS);
        delay *= slowStartMultiplier;
      }

      acc += delay;
      sessionCount += 1;
      i += 1;
    }

    this.currentIndex = Math.min(this.words.length - 1, i);

    // Preserve history so rewind still works after a forward jump.
    // We "anchor" the new position at (old playbackMs + acc).
    const newT = this.playbackMs + acc;

    // If we were in the past (shouldn't happen in this branch), discard future.
    if (this.historyCursor < this.history.length - 1) {
      this.history = this.history.slice(0, this.historyCursor + 1);
    }

    this.playbackMs = newT;

    // Add an anchor entry at the new position/time
    this.history.push({ index: this.currentIndex, tMs: this.playbackMs });
    this.historyCursor = this.history.length - 1;

    // Trim window
    while (
      this.history.length > RSVPEngine.MAX_HISTORY_ENTRIES ||
      (this.history.length > 0 && this.playbackMs - this.history[0].tMs > RSVPEngine.MAX_HISTORY_MS)
    ) {
      this.history.shift();
      this.historyCursor -= 1;
    }
    if (this.historyCursor < -1) this.historyCursor = -1;

    if (wasPlaying) this.play();
    else this.displayCurrentWord();
  }

  private getWpmSetting(): number {
    return this.useMobileProfile ? this.settings.mobileWpm : this.settings.wpm;
  }
  private setWpmSetting(v: number): void {
    if (this.useMobileProfile) this.settings.mobileWpm = v;
    else this.settings.wpm = v;
  }

  private getChunkSizeSetting(): number {
    return this.useMobileProfile ? this.settings.mobileChunkSize : this.settings.chunkSize;
  }
  private setChunkSizeSetting(v: number): void {
    if (this.useMobileProfile) this.settings.mobileChunkSize = v;
    else this.settings.chunkSize = v;
  }

  private getEnableSlowStartSetting(): boolean {
    return this.useMobileProfile ? this.settings.mobileEnableSlowStart : this.settings.enableSlowStart;
  }
  private getEnableMicropauseSetting(): boolean {
    return this.useMobileProfile ? this.settings.mobileEnableMicropause : this.settings.enableMicropause;
  }

  private displayCurrentWord(): void {
    while (this.currentIndex < this.words.length && this.words[this.currentIndex] === '\n') {
      this.currentIndex += 1;
    }
    if (this.currentIndex >= this.words.length) {
      return;
    }

    const chunk = this.getChunk(this.currentIndex);
    this.onWordChange(chunk);
  }

  private displayNextWord(): void {
    if (!this.isPlaying) return;

    const gen = this.tickGen;

    // Skip linebreak tokens so we always advance through real words
    while (this.currentIndex < this.words.length && this.words[this.currentIndex] === '\n') {
      this.currentIndex += 1;
    }

    if (this.currentIndex >= this.words.length) {
      this.isPlaying = false;
      return;
    }

    const chunk = this.getChunk(this.currentIndex);
    this.onWordChange(chunk);

    let delay = chunk.delay;

    if (this.getEnableSlowStartSetting()) {
      const SLOW_START_WORDS = 5;
      if (this.wordsReadInSession < SLOW_START_WORDS) {
        const remainingSlowWords = SLOW_START_WORDS - this.wordsReadInSession;
        const slowStartMultiplier = 1 + (remainingSlowWords / SLOW_START_WORDS);
        delay *= slowStartMultiplier;
      }
    }

    this.wordsReadInSession += 1;

    // record the *actual* scheduled delay for time-based seeking
    this.recordHistory(this.currentIndex, delay);

    // CRITICAL: advance by ONE token every tick (not chunkSize)
    this.currentIndex += 1;

    const now = this.nowMs();
    const delayMs = Math.max(0, delay);

    // Initialise anchor on first tick after play()
    if (this.nextDueMs == null) this.nextDueMs = now;

    // Set the next due-time based on intended delay
    this.nextDueMs += delayMs;

    let waitMs = this.nextDueMs - now;

    // If we’re massively behind (tab stall / throttling), resync to avoid turbo bursts.
    if (waitMs < -250) {
      this.nextDueMs = now + delayMs;
      waitMs = delayMs;
    }

    this.timer = this.timeoutManager.setTimeout(() => {
      if (gen !== this.tickGen) return; // stale callback; ignore
      this.displayNextWord();
    }, Math.max(0, waitMs));
  }

  private getChunk(startIndex: number): WordChunk {
    const chunkSize = Math.max(1, this.getChunkSizeSetting() || 1);

    const chunkWords: string[] = [];
    let i = startIndex;

    while (i < this.words.length && chunkWords.length < chunkSize) {
      const w = this.words[i];
      if (w !== '\n') chunkWords.push(w);
      i++;
    }

    const text = chunkWords.join(' ');

    const focusWordRaw = chunkWords[0] ?? '';
    let delayToken = focusWordRaw;

    // If this word is immediately followed by a linebreak token, fold that into the delay
    // so paragraph micropauses apply like they did when '\n' existed inside the evaluated token/string.
    if (startIndex + 1 < this.words.length && this.words[startIndex + 1] === '\n') {
      delayToken += '\n';
    }

    const delay = this.calculateDelay(delayToken);

    return {
      text,
      index: startIndex,
      delay,
      isEnd: startIndex >= this.words.length - 1,
      headingContext: this.getCurrentHeadingContext(startIndex)
    };
  }

  private getCurrentWpm(): number {
    // Si l'accélération n'est pas activée, retourner le WPM normal
    if (!this.settings.enableAcceleration || this.startTime === 0) {
      return this.getWpmSetting();
    }

    // Calculer le temps écoulé (en secondes)
    const now = this.isPlaying ? Date.now() : (this.lastPauseTime || Date.now());
    const elapsed = (now - this.startTime - this.pausedTime) / 1000;

    // Si on a dépassé la durée d'accélération, retourner le WPM cible
    if (elapsed >= this.settings.accelerationDuration) {
      return this.settings.accelerationTargetWpm;
    }

    // Calculer le WPM progressif
    const progress = elapsed / this.settings.accelerationDuration;
    const wpmDiff = this.settings.accelerationTargetWpm - this.startWpm;
    const currentWpm = this.startWpm + (wpmDiff * progress);

    return Math.round(currentWpm);
  }

  private calculateDelay(text: string): number {
    const currentWpm = this.getCurrentWpm();
    const baseDelay = (60 / currentWpm) * 1000;

    // Calculate micropause multiplier using service
    const multiplier = this.micropauseService.calculateMultiplier(text);

    return baseDelay * multiplier;
  }

  /**
   * Extract all headings and callouts from the words array
   * Headings are marked with [H1], [H2], etc.
   * Callouts are marked with [CALLOUT:type] by the markdown parser
   *
   * Since text is split into words, we need to collect all words
   * that belong to the same heading/callout title.
   */
  private extractHeadings(): void {
    this.headings = [];

    for (let i = 0; i < this.words.length; i++) {
      const word = this.words[i];

      // Check for regular headings [H1], [H2], etc.
      const headingMatch = word.match(/^\[H(\d)\](.+)/);
      if (headingMatch) {
        const level = parseInt(headingMatch[1]);
        const firstWord = headingMatch[2];

        // Collect following words until we hit a line break marker
        // Headings are single-line, so we stop at §§LINEBREAK§§
        const titleWords = [firstWord];
        let j = i + 1;
        while (j < this.words.length) {
          const nextWord = this.words[j];

          // Stop if we hit the line break marker
          if (nextWord === '§§LINEBREAK§§') {
            break;
          }

          // Stop if we hit another marker
          if (/^\[H\d\]/.test(nextWord) || /^\[CALLOUT:/.test(nextWord)) {
            break;
          }

          // Add word to title
          titleWords.push(nextWord);
          j++;

          // Safety limit: max 20 words for a heading
          if (titleWords.length >= 20) {
            break;
          }
        }

        const text = titleWords.join(' ').trim();

        this.headings.push({
          level,
          text,
          wordIndex: i
        });
        continue;
      }

      // Check for callouts [CALLOUT:type]Title
      const calloutMatch = word.match(/^\[CALLOUT:([\w-]+)\](.+)/);
      if (calloutMatch) {
        const calloutType = calloutMatch[1];
        const firstWord = calloutMatch[2];

        // Collect following words until we hit a line break marker
        // Callout titles are single-line, so we stop at §§LINEBREAK§§
        const titleWords = [firstWord];
        let j = i + 1;
        while (j < this.words.length) {
          const nextWord = this.words[j];

          // Stop if we hit the line break marker
          if (nextWord === '§§LINEBREAK§§') {
            break;
          }

          // Stop if we hit another marker
          if (/^\[H\d\]/.test(nextWord) || /^\[CALLOUT:/.test(nextWord)) {
            break;
          }

          // Add word to title
          titleWords.push(nextWord);
          j++;

          // Safety limit: max 20 words for a callout title
          if (titleWords.length >= 20) {
            break;
          }
        }

        const text = titleWords.join(' ').trim();

        this.headings.push({
          level: 7, // Callouts are LOWER priority than H6 (H1..H6)
          text,
          wordIndex: i,
          calloutType
        });
      }
    }
  }

  /**
   * Get the current heading context (breadcrumb) for a given word index
   * Returns the hierarchical path of headings leading to the current position
   *
   * @param wordIndex - Word index to get context for
   * @returns Heading context with breadcrumb path and current heading
   */
  getCurrentHeadingContext(wordIndex: number): HeadingContext {
    if (this.headings.length === 0) {
      return { breadcrumb: [], current: null };
    }

    // Find all headings before or at the current position
    const relevantHeadings = this.headings.filter(h => h.wordIndex <= wordIndex);

    if (relevantHeadings.length === 0) {
      return { breadcrumb: [], current: null };
    }

    // Build hierarchical breadcrumb
    const breadcrumb: HeadingInfo[] = [];
    let currentLevel = 0;

    for (const heading of relevantHeadings) {
      // If this heading is at a lower or equal level than current, reset the breadcrumb up to this level
      if (heading.level <= currentLevel) {
        // Remove all headings from this level onwards
        while (breadcrumb.length > 0 && breadcrumb[breadcrumb.length - 1].level >= heading.level) {
          breadcrumb.pop();
        }
      }

      breadcrumb.push(heading);
      currentLevel = heading.level;
    }

    return {
      breadcrumb,
      current: breadcrumb[breadcrumb.length - 1] || null
    };
  }

  getProgress(): number {
    return this.words.length > 0
      ? (this.currentIndex / this.words.length) * 100
      : 0;
  }

  getCurrentIndex(): number {
    return this.currentIndex;
  }

  getTotalWords(): number {
    return this.words.length;
  }

  getIsPlaying(): boolean {
    return this.isPlaying;
  }

  setWpm(wpm: number): void {
    this.setWpmSetting(Math.max(50, Math.min(5000, wpm)));
    this.rebuildVirtualTimeline();
  }

  getWpm(): number {
    return this.getWpmSetting();
  }

  setChunkSize(size: number): void {
    this.setChunkSizeSetting(Math.max(1, Math.min(5, size)));
  }

  getChunkSize(): number {
    return this.getChunkSizeSetting();
  }

  // ---------------------------------------------------------------------------
  // Line-based context (replaces old word-based context)
  // ---------------------------------------------------------------------------

  private isLineBreakToken(t: string | undefined): boolean {
    return t === '\n' || t === '§§LINEBREAK§§';
  }

  private findLineStart(index: number): number {
    // start = first token AFTER the previous '\n'
    let i = Math.max(0, Math.min(index, this.words.length));
    while (i > 0 && !this.isLineBreakToken(this.words[i - 1])) i--;
    return i;
  }

  private findLineEnd(index: number): number {
    // end = index of '\n' OR words.length (exclusive end)
    let i = Math.max(0, Math.min(index, this.words.length));
    while (i < this.words.length && !this.isLineBreakToken(this.words[i])) i++;
    return i;
  }

  private getPrevLineRange(currentLineStart: number): { start: number; end: number; prevSeparator: number } | null {
    // currentLineStart is first token of current line.
    // The separator before current line is at currentLineStart - 1 (may be '\n' or -1).
    let sep = currentLineStart - 1;
    if (sep < 0) return null;

    // sep points to '\n' (or multiple '\n' for blank lines).
    // Previous line ends at sep (exclusive).
    const end = sep;

    // Find previous separator (or start)
    while (sep > 0 && !this.isLineBreakToken(this.words[sep - 1])) sep--;
    const start = sep;

    return { start, end, prevSeparator: start - 1 };
  }

  private getNextLineRange(currentLineEnd: number): { start: number; end: number; nextSeparator: number } | null {
    // currentLineEnd is index of '\n' or words.length.
    if (currentLineEnd >= this.words.length) return null;

    // currentLineEnd points at '\n'. Next line starts after it.
    const start = currentLineEnd + 1;
    if (start > this.words.length) return null;

    // Find next '\n' (or end)
    let end = start;
    while (end < this.words.length && !this.isLineBreakToken(this.words[end])) end++;

    return { start, end, nextSeparator: end };
  }

  private getActiveChunkEndOnThisLine(startIndex: number): number {
    // Chunk is the active phrase. We clamp it to THIS LINE so anchor semantics remain line-based.
    const chunkSize = Math.max(1, this.getChunkSizeSetting() || 1);

    const lineEnd = this.findLineEnd(startIndex);
    let count = 0;
    let i = startIndex;
    let last = startIndex;

    while (i < lineEnd && count < chunkSize) {
      const w = this.words[i];
      if (!this.isLineBreakToken(w)) {
        last = i;
        count++;
      }
      i++;
    }

    return last;
  }

  /**
   * Returns line-based context around the active chunk:
   * - BEFORE: N full lines above + anchor-before (words before active chunk on current line)
   * - AFTER : anchor-after (words after active chunk on current line) + N full lines below
   *
   * `lines` is 0..10 (0 means anchor line only).
   */
  public getContextLines(startIndex: number, lines: number): { before: string[]; after: string[] } {
    const idx = Math.max(0, Math.min(startIndex, this.words.length - 1));
    const n = Math.max(0, Math.floor(lines));

    const lineStart = this.findLineStart(idx);
    const lineEnd = this.findLineEnd(idx);

    const chunkEnd = this.getActiveChunkEndOnThisLine(idx);

    // Anchor line (split)
    const anchorBefore = this.words.slice(lineStart, idx).filter(t => !this.isLineBreakToken(t));
    const anchorAfter  = this.words.slice(idx + 1, lineEnd).filter(t => !this.isLineBreakToken(t));

    // Collect N lines above (oldest -> nearest)
    const aboveLines: string[][] = [];
    let cursorStart = lineStart;
    for (let k = 0; k < n; k++) {
      const prev = this.getPrevLineRange(cursorStart);
      if (!prev) break;
      aboveLines.unshift(this.words.slice(prev.start, prev.end).filter(t => !this.isLineBreakToken(t)));
      cursorStart = prev.start;
    }

    // Collect N lines below (nearest -> further)
    const belowLines: string[][] = [];
    let cursorEnd = lineEnd;
    for (let k = 0; k < n; k++) {
      const next = this.getNextLineRange(cursorEnd);
      if (!next) break;
      belowLines.push(this.words.slice(next.start, next.end).filter(t => !this.isLineBreakToken(t)));
      cursorEnd = next.end;
    }

    // Flatten with explicit '\n' between lines
    const before: string[] = [];
    for (let i = 0; i < aboveLines.length; i++) {
      before.push(...aboveLines[i]);
      before.push('\n');
    }
    // anchor-before is always the final line in BEFORE (can be empty)
    before.push(...anchorBefore);

    const after: string[] = [];
    // anchor-after is always the first line in AFTER (can be empty)
    after.push(...anchorAfter);
    for (let i = 0; i < belowLines.length; i++) {
      after.push('\n');
      after.push(...belowLines[i]);
    }

    return { before, after };
  }

  /**
   * Returns a token window around the current word for UI-level (wrapped) context rendering.
   * Includes explicit line break tokens ('\n') and internal markers; the view layer formats it.
   */
  public getContextTokenWindow(
    index: number,
    backTokens: number,
    forwardTokens: number
  ): { before: string[]; after: string[] } {
    const len = this.words.length;
    if (len === 0) return { before: [], after: [] };

    const idx = Math.max(0, Math.min(index, len - 1));
    const back = Math.max(0, Math.floor(backTokens));
    const fwd = Math.max(0, Math.floor(forwardTokens));
  
    const start = Math.max(0, idx - back);

    // BEFORE: exclude the focused word; trim trailing line breaks
    const before = this.words.slice(start, idx);
    while (before.length && before[before.length - 1] === '\n') before.pop();

    // AFTER: start immediately after the focused word (NOT after the full displayed chunk)
    let afterStart = Math.min(len, idx + 1);
    while (afterStart < len && this.words[afterStart] === '\n') afterStart += 1;

    const end = Math.min(len, afterStart + fwd);
    const after = this.words.slice(afterStart, end);

    return { before, after };
  }

  public getVirtualTotalSeconds(): number {
    return Math.round(this.virtualTotalMs / 1000);
  }

  public getVirtualElapsedSecondsAtCurrentIndex(): number {
    if (this.words.length === 0) return 0;
    const idx = Math.max(0, Math.min(this.currentIndex, this.words.length - 1));
    return Math.round((this.virtualTimeAtIndexMs[idx] || 0) / 1000);
  }

  public getVirtualRemainingSeconds(): number {
    const total = this.getVirtualTotalSeconds();
    const elapsed = this.getVirtualElapsedSecondsAtCurrentIndex();
    return Math.max(0, total - elapsed);
  }

  public getVirtualElapsedSecondsAtIndex(index: number): number {
    if (this.words.length === 0) return 0;
    const idx = Math.max(0, Math.min(index, this.words.length - 1));
    return Math.round((this.virtualTimeAtIndexMs[idx] || 0) / 1000);
  }

  private findVirtualIndexAtOrBeforeMs(tMs: number): number {
    const n = this.words.length;
    if (n === 0) return 0;

    let lo = 0, hi = n - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.virtualTimeAtIndexMs[mid] <= tMs) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  private findVirtualIndexAtOrAfterMs(tMs: number): number {
    const n = this.words.length;
    if (n === 0) return 0;

    let lo = 0, hi = n - 1, ans = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.virtualTimeAtIndexMs[mid] >= tMs) { ans = mid; hi = mid - 1; }
      else lo = mid + 1;
    }
    return ans;
  }

  private seedHistoryAtCurrentIndex(): void {
    const tMs = this.virtualTimeAtIndexMs[this.currentIndex] ?? 0;
    this.playbackMs = tMs;
    this.history = [{ index: this.currentIndex, tMs }];
    this.historyCursor = 0;
  }

  updateSettings(settings: DashReaderSettings): void {
    this.settings = settings;
    this.micropauseService.updateSettings(settings, this.getEnableMicropauseSetting());
    this.rebuildVirtualTimeline();
  }

  getEstimatedDuration(): number {
    // Unified estimate: use the engine's virtual timeline model (same as progress bar).
    return this.getVirtualRemainingSeconds();
  }

  private calculateAccurateRemainingTime(wpm: number): number {
    // Calcule le temps total en millisecondes pour lire tous les mots restants
    // en tenant compte de TOUTES les micropauses (ponctuation, mots longs, headings, etc.)
    if (this.words.length === 0 || this.currentIndex >= this.words.length) return 0;

    let totalTimeMs = 0;
    const baseDelay = (60 / wpm) * 1000; // Délai de base par mot en ms

    for (let i = this.currentIndex; i < this.words.length; i++) {
      const word = this.words[i];

      // Calculate micropause multiplier using service
      const multiplier = this.micropauseService.calculateMultiplier(word);

      totalTimeMs += baseDelay * multiplier;
    }

    // Convertir en secondes et arrondir
    return Math.ceil(totalTimeMs / 1000);
  }

  getRemainingWords(): number {
    // Retourne le nombre de mots restants à lire
    return Math.max(0, this.words.length - this.currentIndex);
  }

  getElapsedTime(): number {
    // Retourne le temps écoulé en secondes
    if (this.startTime === 0) return 0;

    const now = this.isPlaying ? Date.now() : this.lastPauseTime || Date.now();
    return Math.floor((now - this.startTime - this.pausedTime) / 1000);
  }

  getRemainingTime(): number {
    // Unified remaining time: use the engine's virtual timeline model.
    return this.getVirtualRemainingSeconds();
  }

  getCurrentWpmPublic(): number {
    // Méthode publique pour obtenir le WPM actuel (pour affichage)
    return this.getCurrentWpm();
  }

  /**
   * Returns all headings extracted from the document
   * Useful for navigation and section counting
   */
  getHeadings(): HeadingInfo[] {
    return this.headings;
  }

  jumpToIndex(index: number): void {
    if (this.words.length === 0) return;

    this.currentIndex = Math.max(0, Math.min(index, this.words.length - 1));
    this.resetHistory();
    this.seedHistoryAtCurrentIndex(); // ensures rewind works immediately after a jump

    if (this.isPlaying) {
      this.pause();
      this.play();
    } else {
      this.displayCurrentWord();
    }
  }

  /**
   * Move by N real words (skipping '\n' tokens).
   * Negative = backward, positive = forward.
   * Keeps behavior consistent with jumpToIndex() (updates display / restarts timer if playing).
   */
  stepWords(wordDelta: number): void {
    if (this.words.length === 0 || wordDelta === 0) return;

    this.moveByWords(wordDelta);
    this.resetHistory();
    this.seedHistoryAtCurrentIndex(); // keep playbackMs consistent after wheel-stepping

    if (this.isPlaying) {
      this.pause();
      this.play();
    } else {
      this.displayCurrentWord();
    }
  }

  jumpToStart(): void {
    this.jumpToIndex(0);
  }

  jumpToEnd(): void {
    this.jumpToIndex(this.words.length - 1);
  }
}
