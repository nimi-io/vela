import { test } from "node:test";
import assert from "node:assert/strict";
import { rewriteMaster, rewriteMediaKey, rewriteMpd, rewriteLiveMaster, storyboardVtt } from "./manifest.js";

const master = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-STREAM-INF:BANDWIDTH=2340800,RESOLUTION=1280x720,CODECS="avc1.42c01f,mp4a.40.2"
720p/index.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=1020800,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2"
360p/index.m3u8
`;

test("rewrites variant URIs under base", () => {
  const out = rewriteMaster(master, "/PID/p/hls/");
  assert.match(out, /^\/PID\/p\/hls\/720p\/index\.m3u8$/m);
  assert.match(out, /^\/PID\/p\/hls\/360p\/index\.m3u8$/m);
});

test("filters by max resolution", () => {
  const out = rewriteMaster(master, "/b/", { maxShortSide: 480 });
  assert.doesNotMatch(out, /720p/);
  assert.match(out, /360p/);
});

test("keeps one rendition when filter excludes all", () => {
  const out = rewriteMaster(master, "/b/", { maxShortSide: 100 });
  assert.match(out, /360p/);
});

test("adds subtitle groups", () => {
  const out = rewriteMaster(master, "/b/", {
    subtitles: [{ id: "t1", name: "English", language: "en" }],
    subtitleUri: (id) => `/b/subs/${id}.m3u8`,
  });
  assert.match(out, /#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en"/);
  assert.equal((out.match(/SUBTITLES="subs"/g) ?? []).length, 2);
});

test("rewrites EXT-X-MEDIA audio URIs (packager output)", () => {
  const m = `#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/index.m3u8",GROUP-ID="audio",NAME="Default"\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360,AUDIO="audio"\n360p/index.m3u8\n`;
  const out = rewriteMaster(m, "/b/");
  assert.match(out, /URI="\/b\/audio\/index\.m3u8"/);
});

test("aes key placeholder", () => {
  assert.equal(rewriteMediaKey('#EXT-X-KEY:METHOD=AES-128,URI="vela-key://asset",IV=0x1', "/k"), '#EXT-X-KEY:METHOD=AES-128,URI="/k",IV=0x1');
});

test("mpd base url", () => {
  const out = rewriteMpd('<?xml version="1.0"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">\n<Period>', "/PID/p/dash/");
  assert.match(out, /<MPD[^>]*>\n  <BaseURL>\/PID\/p\/dash\/<\/BaseURL>/);
});

test("live master", () => {
  const out = rewriteLiveMaster('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio2_stream.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvideo1_stream.m3u8', "/PID/p/live/");
  assert.match(out, /URI="\/PID\/p\/live\/audio2_stream\.m3u8"/);
  assert.match(out, /^\/PID\/p\/live\/video1_stream\.m3u8$/m);
});

test("storyboard vtt", () => {
  const out = storyboardVtt({ count: 3, interval: 2, cols: 10, tileWidth: 256 }, 144, "/sb.jpg", 6);
  assert.match(out, /00:00:02\.000 --> 00:00:04\.000\n\/sb\.jpg#xywh=256,0,256,144/);
});
