// The files under a bubble's words, in order: a picture or video drawn in the bubble's own layout
// with the thread's media renderer, any other file as a markdown link that opens it.
// A picture goes in the layout, not through the markdown text: the markdown view lays its
// pictures over itself and keeps a fallback height for them in a bubble that sizes to its content,
// so a tall screenshot spilled over the bubbles below and took the list's touches.
import { Fragment } from "react";
import { useWindowDimensions } from "react-native";

import { MarkdownImageAvailableWidthContext } from "../threads/ThreadMarkdownImage";
import { BubbleMarkdown, bubbleContentWidth } from "./BubbleMarkdown";
import type { RoomMedia } from "./roomMedia";
import { fileLines } from "./roomModel";

export function BubbleFiles(props: {
  readonly files: string;
  readonly body: { readonly fontSize: number; readonly lineHeight: number };
  readonly mine: boolean;
  readonly media: RoomMedia;
}) {
  const { width } = useWindowDimensions();
  return (
    <MarkdownImageAvailableWidthContext value={bubbleContentWidth(width)}>
      {fileLines(props.files).map((file, index) => (
        <Fragment key={`${index}:${file.path}`}>
          {file.embed ? (
            props.media.renderImage({ href: file.path, alt: file.name || null, title: null })
          ) : (
            <BubbleMarkdown markdown={`[${file.name}](<${file.path}>)`} body={props.body} mine={props.mine} media={props.media} />
          )}
        </Fragment>
      ))}
    </MarkdownImageAvailableWidthContext>
  );
}
