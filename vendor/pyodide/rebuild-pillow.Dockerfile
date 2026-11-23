# syntax=docker/dockerfile:1
# Rebuild the vendored Pillow wheel and update its SHA-256 in scripts/python-wheels.json.
# docker build -f vendor/pyodide/rebuild-pillow.Dockerfile --output type=local,dest=vendor/pyodide vendor/pyodide
FROM emscripten/emsdk:4.0.9@sha256:3c853ef9c3b4c2708da1adac2fdfdba49c775fdc4144ceef4989423963e96811 AS toolchain
FROM python:3.13.18-bookworm@sha256:cc55e4ded9c95f6ce2133b3d096db43f214d280c2a8af65d83e246c8fa7d168c AS build
COPY --from=toolchain /emsdk /emsdk
RUN apt-get update -qq && apt-get install -y --no-install-recommends ccache cmake && rm -rf /var/lib/apt/lists/*
RUN <<'BUILD'
#!/bin/bash
set -euo pipefail
export PYODIDE_JOBS=6 SOURCE_DATE_EPOCH=1795392000

mkdir -p /opt/pillow-build /out
cd /opt/pillow-build

download() {
  local file=$1 url=$2 sha=$3
  curl --fail --location --retry 3 --retry-all-errors --max-time 180 --output "$file" "$url"
  printf '%s  %s\n' "$sha" "$file" | sha256sum -c -
  tar -xf "$file"
}

download pillow-13.0.0.tar.gz https://files.pythonhosted.org/packages/ce/a4/9cc30690a394a8305e8be4c9036aa16d0dfddadd09079860b582f562496d/pillow-13.0.0.tar.gz cdcd1ba258178f7356d74170c9a81ba4eab6a5d55748bc402a5a2a6fe6be3510
download libwebp-1.6.0.tar.gz https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0.tar.gz e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564
download tiff-4.7.2.tar.gz https://download.osgeo.org/libtiff/tiff-4.7.2.tar.gz 672bd7d10aee4606171afb864f3570b83340f6a33e2c186dc0512f7145ffdf6a
download xbuildenv-0.29.5.tar.gz https://github.com/pyodide/pyodide/releases/download/0.29.5/xbuildenv-0.29.5.tar.gz 8dbc758ce1f41af7f972ed7ad55a72160364bcc73ab239005607de16a219fdae

git clone --depth 1 --branch 0.29.5 https://github.com/pyodide/pyodide.git /opt/pyodide
test "$(git -C /opt/pyodide rev-parse HEAD)" = 05804b32e55628ad2269655f3c5a097fb4a966ee
cat /opt/pyodide/emsdk/patches/*.patch | patch -p1 -d /emsdk/upstream/emscripten
git -C /opt/pyodide submodule update --init --depth 1 pyodide-build
python -m pip install --disable-pip-version-check /opt/pyodide/pyodide-build
source /emsdk/emsdk_env.sh
export EM_CONFIG=/emsdk/.emscripten

embuilder build --pic libjpeg zlib freetype libpng
prefix="$PWD/static"
emcmake cmake -S libwebp-1.6.0 -B webp-cross \
  -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DCMAKE_INSTALL_PREFIX="$prefix" \
  -DWEBP_ENABLE_THREADING=OFF -DWEBP_BUILD_ANIM_UTILS=OFF -DWEBP_BUILD_CWEBP=OFF \
  -DWEBP_BUILD_DWEBP=OFF -DWEBP_BUILD_GIF2WEBP=OFF -DWEBP_BUILD_IMG2WEBP=OFF \
  -DWEBP_BUILD_VWEBP=OFF -DWEBP_BUILD_WEBPINFO=OFF -DWEBP_BUILD_WEBPMUX=OFF \
  -DWEBP_BUILD_EXTRAS=OFF
cmake --build webp-cross --parallel "$PYODIDE_JOBS"
cmake --install webp-cross

cache="$(em-config CACHE)/sysroot"
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
emcmake cmake -S tiff-4.7.2 -B tiff-cross \
  -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DCMAKE_INSTALL_PREFIX="$prefix" \
  -DBUILD_SHARED_LIBS=OFF -Dtiff-tools=OFF -Dtiff-tests=OFF -Dtiff-contrib=OFF -Dtiff-docs=OFF -Dcxx=OFF \
  -DJPEG_INCLUDE_DIR="$cache/include" -DJPEG_LIBRARY="$cache/lib/wasm32-emscripten/pic/libjpeg.a" \
  -DZLIB_INCLUDE_DIR="$cache/include" -DZLIB_LIBRARY="$cache/lib/wasm32-emscripten/pic/libz.a" \
  -Dwebp=OFF -Djbig=OFF -Dlerc=OFF -Dlzma=OFF -Dzstd=OFF -Dlibdeflate=OFF
cmake --build tiff-cross --parallel "$PYODIDE_JOBS"
cmake --install tiff-cross

export PYODIDE_ROOT="$PWD/xbuildenv/pyodide-root"
export CFLAGS="-sRELOCATABLE=1 -sUSE_ZLIB=1 -sUSE_FREETYPE=1 -sUSE_LIBPNG=1 -sUSE_LIBJPEG=1 -I$cache/include -I$prefix/include -L$cache/lib/wasm32-emscripten/pic -L$prefix/lib"
export LDFLAGS="-L$cache/lib/wasm32-emscripten/pic -L$prefix/lib -ljpeg -lsharpyuv"
pyodide build pillow-13.0.0 --outdir /out --skip-emscripten-install \
  -C platform-guessing=disable -C zlib=True -C jpeg=True -C freetype=True -C webp=True \
  -C tiff=True -C lcms=False -C xcb=False -C jpeg2000=False -C imagequant=False
BUILD

FROM scratch
COPY --from=build /out/ /
