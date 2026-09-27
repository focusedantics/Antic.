# U²-Netp

- File: `u2netp.onnx` (4.6 MB)
- Model: U²-Net small variant, salient object detection
- Original project: https://github.com/xuebinqin/U-2-Net (Xuebin Qin et al.)
- License: Apache License 2.0 (see `LICENSE`)
- ONNX export: https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx
  (as redistributed in the npm package `@planby-tech/rmbg-webgpu`, MIT AND Apache-2.0)

Focused bundles this small model so Select Subject and Remove Background work fully
offline. When the network is available, the higher-quality BiRefNet model is used.
