// The room's measures, taken from Messages on the user's iPhone at the same scale (user 76b939e4
// and b2a00025 sent the screenshots; 402 pt wide). One place, so the bubble, its markdown and its
// files agree.

/** A bubble is at most this share of the screen's width (279 of 402 pt). */
export const BUBBLE_MAX_WIDTH = 0.694;
/** The words' inset from the bubble's sides. */
export const BUBBLE_PADDING_X = 14;
/** The words' inset from its top and bottom: one line makes a 39 pt bubble. */
export const BUBBLE_PADDING_Y = 10;
export const BUBBLE_RADIUS = 19.6;
/** Line height to font size: Messages sets 16 pt words 19 pt apart. */
export const BUBBLE_LINE_RATIO = 1.19;
/** Between bubbles of one group, and before a group (after a tail, a time line or the other side). */
export const GAP_IN_GROUP = 4;
export const GAP_BEFORE_GROUP = 10;
/** The room's sides. */
export const ROOM_SIDE = 16;
/** Composer: the + circle and the field's height when it holds one line; its sides with and without the keyboard. */
export const COMPOSER_HEIGHT = 39;
export const COMPOSER_SIDE = 28;
export const COMPOSER_SIDE_TYPING = 16;
/** The header: glass buttons, the face, and the name's pill under it. */
export const HEADER_BUTTON = 44;
export const HEADER_AVATAR = 59;
export const HEADER_NAME_HEIGHT = 31;
/** From the top safe edge to the bottom of the name's pill. */
export const HEADER_DEPTH = 86;
