# Photo map: the origin run (2026-10)

A personal photo-map app was deciding how its main map shows many photos. The trigger was small: merged pins and single pins looked alike. The round below replaced an earlier pass that had only collected app screenshots. The user judged it far better.

## Opening the question

- The question was widened from "how do we polish this pin" to "how should many personal photos and places be shown and touched on a map".
- The options already on the table were marked on hold, so the research would not drift into justifying one of them.
- Structures the user had rejected earlier were gathered from past notes. They went in so they would not come back as new ideas.
- The user's instruction went into the brief verbatim: 「응용에 목매어서 높은 퀄리티 정보를 빼놓지도 말고 단계적으로 치밀하게 가보자. 직접적이지 않은것도 응용할건 해도되고 이런방향은 내가 지정해주진 않을게.」 In short: keep high-quality material even when its use is not obvious, indirect fields are welcome, and nobody prescribes the direction.

## Six strands, run at once

1. Cartography and visualisation science
2. Research and engineering on geotagged photo collections
3. Developer communities: issues and maintainers' reasoning in open-source photo apps and map libraries
4. User voices, in Korean and English
5. Makers' write-ups and talks
6. Indirect fields: image walls, zoomable interfaces, game-map icon clutter, self-tracking maps

Each strand prompt was dense with leads. The cartography strand named generalisation operators, clutter measures, proportional-symbol perception studies, animated-transition studies and specific cartographers' critiques, as starting points. The same rules were pasted into all six:
- Open every source you report.
- Prefer primary sources.
- Give verbatim quotes with dates.
- For studies, give the method and sample.
- Label the evidence type.
- List disagreements and gaps.
- Prefer strong sources to many weak ones.

## Recheck

The owner pulled about thirty decisive claims again from the originals: issue threads through the GitHub and Hacker News APIs, paper PDFs and talk transcripts. One claim fell. "Naver's cluster tap does not zoom" came from a 2016 web sample; the current mobile guide zooms.

## What the digest held

The digest had no recommendation. It contained:
- Findings with their conditions:
  - Two open-source photo apps had changed cluster taps from "zoom in" to "open the photos" after years of user requests.
  - In Airbnb's experiment, showing fewer, better-chosen pins raised bookings by 1.9%, while removing pins at random lowered them by 1.5%.
  - People underestimate size differences between symbols.
- Principles from indirect fields.
- Good material whose use was unclear.
- A check of each premise of the current design: one place, one pin; size means count; merge only a little; a tap opens a sheet. Each premise was marked as supported, challenged or open.
- Conflicting evidence.
- Gaps. The largest gap: no study of personal photo maps on a phone.

Two slips got through, and they are the lessons:
- One short summary kept "fewer pins, more bookings" and dropped the random-removal result.
- One maintainer's "arbitrarily, about 30 metres" grew into "all these defaults are guesses".

## Judgment and the user's choice

- An outside judgment received the digest, the user's words and the failed attempts. It reframed the question from "how to mark a cluster" to "what one mark stands for, and where a tap leads".
- An independent session that knew the history argued with parts of it. It also caught the lead re-proposing a structure the user had rejected weeks before.
- The two judgments disagreed on one point. That point went to the user as something to decide by seeing: real-scale mock-ups of both options, built from the user's own photo data. The research did not pre-empt that choice.

## Follow-up: photo counts per place (2026-10)

A later investigation for the same family of products asked how a map video should show one place with 3, 5, 10, 15 or more photos. One delegated owner ran it on the revised skill. It reframed the question from "pick one of three compositions" to "how a place's seconds are shared between big viewing, fast flow and a bundle", read the papers and product pages directly, and wrote their conditions into the record. Review still found:

- Conditions written correctly in the evidence notes did not stop headings, the summary and the recommendations from stating stronger claims.
- A tracking capacity measured under hard conditions ("as low as 1-2 objects", identical dots) became a general limit for photo cards. A flash count from an accessibility rule became a minimum display time per photo.
- The owner had reframed the problem as time allocation, then did not put its own recommended compositions into the place's seconds. They did not fit.
- Rereading the record did not catch these. Checking each drafted claim against its passage or calculation, with the assumptions needed to apply it, did.

