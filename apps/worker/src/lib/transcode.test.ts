import { test } from "node:test";
import assert from "node:assert/strict";
import { drmPackagerArgs } from "./transcode.js";

const drm = { keyId: "00112233445566778899aabbccddeeff", key: "ffeeddccbbaa99887766554433221100", iv: "0102030405060708090a0b0c0d0e0f10" };
const flag = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};

test("drmPackagerArgs writes the MPD next to the segments so packager emits relative segment URLs", () => {
  const args = drmPackagerArgs("/work/a/out/hls", "/work/a/out/hls/_mezz", ["720p.mp4", "audio.mp4"], drm);
  const mpd = flag(args, "--mpd_output")!;
  assert.equal(mpd, "/work/a/out/hls/manifest.mpd");
  // Every init/segment path must live under the MPD's directory, otherwise packager writes the
  // worker's absolute filesystem path into the MPD and players 404.
  const mpdDir = mpd.slice(0, mpd.lastIndexOf("/") + 1);
  const paths = args.flatMap((a) => [...a.matchAll(/(?:init_segment|segment_template)=([^,]+)/g)].map((m) => m[1]!));
  assert.equal(paths.length, 4);
  for (const p of paths) assert.ok(p.startsWith(mpdDir), `${p} is not under ${mpdDir}`);
});

test("drmPackagerArgs uses the expected protection settings", () => {
  const args = drmPackagerArgs("/o", "/o/_mezz", ["360p.mp4"], drm);
  assert.equal(flag(args, "--protection_scheme"), "cbcs");
  assert.equal(flag(args, "--keys"), `label=:key_id=${drm.keyId}:key=${drm.key}`);
  assert.equal(flag(args, "--protection_systems"), "Widevine,PlayReady,FairPlay,CommonSystem");
  assert.equal(flag(args, "--hls_key_uri"), `skd://${drm.keyId}`);
  assert.equal(flag(args, "--hls_master_playlist_output"), "/o/master.m3u8");
  assert.ok(!args.some((a) => a.includes("audio")), "no audio stream without audio.mp4");
});
