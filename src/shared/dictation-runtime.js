'use strict';

// Runtime source and model are separate pins. Only the model downloads at use
// time; Freedom builds the CLI from this source before packaging the app.
const WHISPER_VERSION = '1.9.5';
const WHISPER_REVISION = 'd1be6fde11ac6e0407606b4e42fe72d34add8037';
const WHISPER_SOURCE_SHA256 = '645445da884df6dbd52b30f82d7be7c01d1767c938714e477e786b88d529e9f4';
const MODEL_REVISION = '5359861c739e955e79d9a303bcbc70fb988958b1';
const MODEL_SHA256 = '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe';
const MODEL_BYTES = 147951465;
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${MODEL_REVISION}/ggml-base.bin`;
const SUPPORTED_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'];

module.exports = { WHISPER_VERSION, WHISPER_REVISION, WHISPER_SOURCE_SHA256,
  MODEL_REVISION, MODEL_SHA256, MODEL_BYTES, MODEL_URL, SUPPORTED_TARGETS };
