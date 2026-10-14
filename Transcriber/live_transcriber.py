#!/usr/bin/env python3
"""Live speech-to-text in the terminal using Vosk (offline).

Setup:
    pip install vosk sounddevice
    # Linux may also need: sudo apt install libportaudio2

Run:
    python live_transcribe.py
"""
import json
import queue
import sys

import sounddevice as sd
from vosk import KaldiRecognizer, Model, SetLogLevel

SAMPLE_RATE = 16000
CLEAR_LINE = "\r\033[K"

audio_q: queue.Queue = queue.Queue()


def on_audio(indata, frames, time, status):
    """Called by sounddevice for every chunk of mic audio."""
    if status:
        print(status, file=sys.stderr)
    audio_q.put(bytes(indata))


def main():
    SetLogLevel(-1)  # silence Vosk's logging
    # Downloads a small English model on first run. Use a larger one for
    # better accuracy, e.g. Model(model_name="vosk-model-en-us-0.22")
    model = Model(lang="en-us")
    recognizer = KaldiRecognizer(model, SAMPLE_RATE)

    with sd.RawInputStream(
        samplerate=SAMPLE_RATE,
        blocksize=4000,
        dtype="int16",
        channels=1,
        callback=on_audio,
    ):
        print("Listening... press Ctrl+C to stop.\n")
        try:
            while True:
                data = audio_q.get()
                if recognizer.AcceptWaveform(data):
                    # Speaker paused: this sentence is finalized
                    text = json.loads(recognizer.Result()).get("text", "")
                    if text:
                        print(f"{CLEAR_LINE}{text}")
                else:
                    # Still speaking: show live, in-progress text
                    partial = json.loads(recognizer.PartialResult()).get("partial", "")
                    print(f"{CLEAR_LINE}{partial}", end="", flush=True)
        except KeyboardInterrupt:
            print(f"{CLEAR_LINE}Stopped.")


if __name__ == "__main__":
    main()