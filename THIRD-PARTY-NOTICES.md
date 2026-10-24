# Third-Party Notices

This repository contains components that are not covered by the root
`LICENSE` (proprietary, all rights reserved). They remain under their own
terms, listed below.

## 1. DouZero-derived inference code — Apache-2.0

`douzero/` (in particular `douzero/src/`, and `douzero/server.py`) is derived
from **DouZero** by Kwai Inc.:

- Upstream: https://github.com/kwai/DouZero
- License: Apache License 2.0 (full text in [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt))
- Copyright: Copyright 2021 Kwai Inc.

Modifications made in this repository: the original `douzero/env/` package was
flattened into a minimal inference-only package, and the service was rewritten
to run inference through ONNX Runtime instead of PyTorch.

Apache-2.0 requires that this notice, the copyright notice and the license
text be retained when the derived work is distributed.

## 2. ONNX model files — Apache-2.0

`douzero/models/**/*.onnx` (9 files) are pre-trained DouZero baseline weights in
ONNX form, obtained from the Hugging Face mirror
`palemoky/douzero-baselines`:

- Source: https://huggingface.co/palemoky/douzero-baselines
- License: Apache License 2.0 (declared by the mirror's model card:
  `license: apache-2.0`; full text in [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt))
- Upstream: DouZero by Kwai Inc. & Texas A&M University
  (https://github.com/kwai/DouZero, Apache-2.0), paper arXiv:2106.06135

The ONNX conversion is provided by the mirror repository. These weights are not
covered by the root `LICENSE`.

## 3. Media assets — provenance to be verified

Audio files under `apps/client/src/static/audio/`,
`apps/client/src/pages/table/static/audio/`, and image assets under
`apps/client/src/static/ui/` were not created for this repository with a
recorded license. Their terms are unknown; they are not covered by the root
`LICENSE`.

## 4. npm / PyPI dependencies

Third-party packages declared in `package.json`, `pnpm-lock.yaml`,
`douzero/pyproject.toml` and `douzero/uv.lock` remain under their respective
licenses. They are not vendored into this repository (except as required by
the lockfiles).
