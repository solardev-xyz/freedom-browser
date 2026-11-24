'use strict';

// Runtime source and model are separate pins. Only the model downloads at use
// time; Freedom builds the CLI from this source before packaging the app.
const WHISPER_VERSION = '1.9.5';
const WHISPER_REVISION = 'd1be6fde11ac6e0407606b4e42fe72d34add8037';
// SHA-256 over the extracted source tree's paths and file contents, not over
// GitHub's regenerated archive bytes (see scripts/build-dictation-runtime.js).
const WHISPER_SOURCE_TREE_SHA256 = '2dd351ef7699dcf04b9355f7ba19a88b4c78e948e5fce65eabdbaf85daffc845';
const MODEL_REVISION = '5359861c739e955e79d9a303bcbc70fb988958b1';
const MODEL_SHA256 = '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe';
const MODEL_BYTES = 147951465;
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${MODEL_REVISION}/ggml-base.bin`;
// The one user-facing name for this model: Settings, the composer chooser and
// the download progress all say it (#803).
const MODEL_NAME = 'Whisper Base';
const SUPPORTED_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'];

module.exports = { WHISPER_VERSION, WHISPER_REVISION, WHISPER_SOURCE_TREE_SHA256,
  MODEL_REVISION, MODEL_SHA256, MODEL_BYTES, MODEL_URL, MODEL_NAME, SUPPORTED_TARGETS };
