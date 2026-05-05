/**
 * Whisper.cpp's SRT output occasionally contains placeholder cues like
 * "[BLANK_AUDIO]" or "[ Music ]" and stray whitespace. Strip those, drop
 * empty cues, and renumber so the output is clean and stable.
 *
 * Returns the cleaned SRT content. Throws if zero cues remain (likely a
 * silent track or transcription failure).
 */

const PLACEHOLDER_PATTERN = /^\[\s*[A-Z_][A-Z0-9 _-]*\s*\]$/i;

export function postProcessSrt(rawSrt) {
  // Normalize line endings, then split into blocks separated by blank lines.
  const blocks = rawSrt.replace(/\r\n/g, '\n').trim().split(/\n{2,}/);

  const cleanedCues = [];

  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;

    // Drop the original cue index (first line, e.g. "1") if present.
    let timecodeLineIdx = 0;
    if (/^\d+$/.test(lines[0])) timecodeLineIdx = 1;

    const timecode = lines[timecodeLineIdx];
    if (!/-->/.test(timecode)) continue;

    const textLines = lines.slice(timecodeLineIdx + 1)
      .map(l => l.trim())
      .filter(l => l.length > 0 && !PLACEHOLDER_PATTERN.test(l));

    if (textLines.length === 0) continue;

    cleanedCues.push({ timecode, text: textLines.join('\n') });
  }

  if (cleanedCues.length === 0) {
    throw new Error('Post-processed SRT contains no cues (silent track or transcription failure?)');
  }

  return cleanedCues
    .map((cue, i) => `${i + 1}\n${cue.timecode}\n${cue.text}`)
    .join('\n\n') + '\n';
}
