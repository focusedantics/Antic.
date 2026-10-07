# Trailer kit

Your own media for the trailer. Everything in this folder except this README is ignored by
git. Any file you leave out is replaced by a stand-in, named `standin-*`.

| File | What works best |
| --- | --- |
| `landscape.jpg` | A wide photo (3:2) with a big sky, shot flat or a little dull, so the Develop before/after and the sky mask show a clear change. |
| `subject.jpg` | One clear subject against a plain background (a person, a pet, a product), for Remove Background. |
| `extra.jpg` | A second photo for the carousel and for "put it anywhere". |
| `clip.mp4` | 3–5 s of video in which something happens around the one-second mark (a turn, a look, a jump). The stutter repeats that moment. |

After changing the kit, run `npm run trailer:capture`, then `npm run trailer:render`.
