/** Re-export so the preview uses the exact same trimming/cap logic as MainAgent (`src/lib/…` on worker). */
export {
  buildCodemodeGuidanceText,
  MAX_CODEMODE_GUIDANCE_CHARS,
} from "../../../src/lib/codemodeGuidanceSettings";
