import { Paperclip, PaperPlaneRight } from "@phosphor-icons/react";
import type { IconProps } from "@phosphor-icons/react";

const ICON_SIZE = "1.35em";

/** Send icon matches Agent Browsing: Phosphor `PaperPlaneRight` at 18px, bold weight. */
const SEND_ICON_SIZE = 18;

/** Composer icons — Phosphor (same family as agents-starter); installed with `npm install --legacy-peer-deps`. */

export function IconPaperclip(props: IconProps) {
  return <Paperclip aria-hidden size={ICON_SIZE} weight="fill" {...props} />;
}

export function IconPaperPlaneRight({ size = SEND_ICON_SIZE, weight = "bold", ...props }: IconProps) {
  return <PaperPlaneRight aria-hidden size={size} weight={weight} {...props} />;
}
