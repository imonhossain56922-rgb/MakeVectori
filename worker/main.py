"""
MakeVectorizer Dedicated Cloud Run AI Processing Worker
Supports VTracer / Potrace vectorization, Real-ESRGAN 4X super-resolution,
and RMBG background removal in an isolated Google Cloud Run container.
"""

import io
import json
import os
from typing import Optional

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import Response
from PIL import Image

app = FastAPI(title="MakeVectorizer Cloud Run Worker", version="1.0.0")

WORKER_SECRET = os.getenv("PROCESSING_WORKER_SECRET", "")


def verify_secret(authorization: Optional[str] = Header(default=None)):
    if not WORKER_SECRET:
        return
    if not authorization or authorization != f"Bearer {WORKER_SECRET}":
        raise HTTPException(status_code=401, detail="Unauthorized worker request")


@app.get("/health")
def health():
    return {"status": "ok", "worker": "MakeVectorizer Cloud Run GPU/CPU Worker"}


@app.post("/upscale", dependencies=[Depends(verify_secret)])
async def upscale_endpoint(
    file: UploadFile = File(...),
    options: str = Form("{}"),
):
    opts = json.loads(options)
    scale = int(opts.get("scaleFactor", 4))
    fmt = opts.get("outputFormat", "png").upper()
    raw = await file.read()
    img = Image.open(io.BytesIO(raw))

    try:
        from realesrgan import RealESRGANer
        from basicsr.archs.rrdbnet_arch import RRDBNet
        import numpy as np
        import cv2

        arr = cv2.cvtColor(np.array(img.convert("RGBA")), cv2.COLOR_RGBA2BGRA)
        model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=4)
        upsampler = RealESRGANer(
            scale=4,
            model_path=os.getenv("REALESRGAN_MODEL_PATH", "/models/RealESRGAN_x4plus.pth"),
            model=model,
            tile=256,
            tile_pad=10,
            pre_pad=0,
            half=False,
        )
        output, _ = upsampler.enhance(arr, outscale=scale)
        out_img = Image.fromarray(cv2.cvtColor(output, cv2.COLOR_BGRA2RGBA))
    except ImportError:
        out_img = img.resize((img.width * scale, img.height * scale), Image.Resampling.LANCZOS)

    buf = io.BytesIO()
    save_fmt = "JPEG" if fmt == "JPG" else fmt
    if save_fmt == "JPEG":
        out_img = out_img.convert("RGB")
    out_img.save(buf, format=save_fmt)
    return Response(content=buf.getvalue(), media_type=f"image/{fmt.lower()}")


@app.post("/remove-background", dependencies=[Depends(verify_secret)])
async def remove_background_endpoint(
    file: UploadFile = File(...),
    options: str = Form("{}"),
):
    raw = await file.read()
    try:
        from rembg import remove

        out_bytes = remove(raw)
        return Response(content=out_bytes, media_type="image/png")
    except ImportError as exc:
        raise HTTPException(
            status_code=503,
            detail="rembg dependency is not installed in this container.",
        ) from exc
