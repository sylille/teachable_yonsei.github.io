// Copyright 2017 Google Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Based on https://github.com/googlecreativelab/teachable-machine/blob/cb6b8ce2/src/ai/WebcamClassifier.js
// Removed extraneous UI code. Refactored a bit.

import * as deeplearn from "./vendor/deeplearn.js";
const {
  GPGPUContext,
  NDArrayMathCPU,
  NDArrayMathGPU,
  Array3D,
  gpgpu_util,
  Scalar,
  Environment,
  environment
} = deeplearn.default;

import SqueezeNet from "./vendor/squeezenet.js";

import browserUtils from "./browserUtils.js";

const IMAGE_SIZE = 227;
const INPUT_SIZE = 1000;
const TOPK = 10;
const CLASS_COUNT = 3;

const MEASURE_TIMING_EVERY_NUM_FRAMES = 20;

class WebcamClassifier {
  constructor(options) {
    this.loaded = false;
    this.video = document.createElement("video");
    this.video.setAttribute("autoplay", "");
    this.video.setAttribute("playsinline", "");

    this.timer = null;
    this.active = false;
    this.wasActive = false;
    this.options = options;
    this.classNames = options.classes.map(classObj => classObj.name);
    this.classes = {};
    for (let index = 0; index < this.classNames.length; index += 1) {
      this.classes[this.classNames[index]] = {
        index: index,
        sampleCount: 0,
        classObj: options.classes[index]
      };
    }
    this.isDown = false;
    this.current = null;

    this.useFloatTextures = !browserUtils.isMobile && !browserUtils.isSafari;

    const features = {};
    features.WEBGL_FLOAT_TEXTURE_ENABLED = this.useFloatTextures;
    const env = new Environment(features);
    environment.setEnvironment(env);

    this.gl = gpgpu_util.createWebGLContext();
    this.gpgpu = new GPGPUContext(this.gl);
    this.math = new NDArrayMathGPU(this.gpgpu);
    this.mathCPU = new NDArrayMathCPU();
    this.currentSampleCallback = null;
    this.trainLogitsMatrix = null;
    this.squashLogitsDenominator = Scalar.new(300);
    this.measureTimingCounter = 0;
    this.lastFrameTimeMs = 1000;

    this.trainClassLogitsMatrices = [];
    this.classExampleCount = [];

    for (let index = 0; index < CLASS_COUNT; index += 1) {
      this.trainClassLogitsMatrices.push(null);
      this.classExampleCount.push(0);
    }
  }

  deleteClassData(index) {
    if (this.trainClassLogitsMatrices[index]) {
      this.trainClassLogitsMatrices[index].dispose();
      this.trainClassLogitsMatrices[index] = null;
      this.trainLogitsMatrix.dispose();
      this.trainLogitsMatrix = null;
      this.classExampleCount[index] = 0;
      this.classes[this.classNames[index]].sampleCount = 0;
    }
  }

  ready() {
    let video = { width: IMAGE_SIZE, height: IMAGE_SIZE };
    if (browserUtils.isMobile) {
      video = {
        ...video,
        facingMode: this.options.isBackFacingCam ? "environment" : "user"
      };
    }
    if (this.loaded) {
      this.startTimer();
    } else if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices
        .getUserMedia({
          video: video
        })
        .then(stream => {
          this.active = true;
          this.stream = stream;
          this.video.addEventListener("loadedmetadata", this.videoLoaded.bind(this));
          this.video.srcObject = stream;
          if (!this.squeezeNet) {
            this.squeezeNet = new SqueezeNet(this.gpgpu, this.math, this.useFloatTextures);
            this.squeezeNet.loadVariables().then(() => {
              this.math.scope(() => {
                const warmupInput = Array3D.zeros([IMAGE_SIZE, IMAGE_SIZE, 3]);
                // Warmup
                const inferenceResult = this.squeezeNet.infer(warmupInput);

                for (const key in inferenceResult.namedActivations) {
                  if (key in inferenceResult.namedActivations) {
                    this.math.track(inferenceResult.namedActivations[key]);
                  }
                }
                this.math.track(inferenceResult.logits);
              });

              this.loaded = true;
              this.wasActive = true;
              this.startTimer();
              let event = new CustomEvent("classifier-loaded");
              window.dispatchEvent(event);
            });
          }

          let event = new CustomEvent("webcam-status", {
            detail: { granted: true }
          });
          window.dispatchEvent(event);
        })
        .catch(error => {
          let event = new CustomEvent("webcam-status", {
            detail: {
              granted: false,
              error: error
            }
          });
          window.dispatchEvent(event);
        });
    }
  }

  videoLoaded() {
    let flip = this.options.isBackFacingCam ? 1 : -1;
    this.video.style.transform = "scaleX(" + flip + ")";
  }

  blur() {
    if (this.timer) {
      this.stopTimer();
    }
  }

  focus() {
    if (this.wasActive) {
      this.startTimer();
    }
  }

  saveTrainingLogits() {
    if (this.trainLogitsMatrix !== null) {
      this.trainLogitsMatrix.dispose();
      this.trainLogitsMatrix = null;
    }

    const logits = this.captureFrameSqueezeNetLogits();
    if (this.trainClassLogitsMatrices[this.current.index] === null) {
      this.trainClassLogitsMatrices[this.current.index] = this.math.keep(logits.as3D(1, INPUT_SIZE, 1));
    } else {
      const axis = 0;
      const newTrainLogitsMatrix = this.math.concat3D(
        this.trainClassLogitsMatrices[this.current.index].as3D(
          this.classExampleCount[this.current.index],
          INPUT_SIZE,
          1
        ),
        logits.as3D(1, INPUT_SIZE, 1),
        axis
      );

      this.trainClassLogitsMatrices[this.current.index].dispose();
      this.trainClassLogitsMatrices[this.current.index] = this.math.keep(newTrainLogitsMatrix);
    }
    this.classExampleCount[this.current.index] += 1;
  }

  getNumExamples() {
    let total = 0;
    for (let index = 0; index < this.classExampleCount.length; index += 1) {
      total += this.classExampleCount[index];
    }

    return total;
  }

  buttonDown(id) {
    this.current = this.classes[id];
    this.isDown = true;
    this.currentSampleCallback = this.classes[id].classObj.sampleCallback;
  }

  buttonUp() {
    this.isDown = false;
    this.current = null;
    this.currentSampleCallback = null;
  }

  startTimer() {
    if (this.timer) {
      this.stopTimer();
    }

    this.video.play();
    this.wasActive = true;
    this.timer = requestAnimationFrame(this.animate.bind(this));
  }

  stopTimer() {
    this.active = false;
    this.wasActive = true;
    this.video.pause();
    cancelAnimationFrame(this.timer);
  }

  animate() {
    if (this.isDown) {
      this.math.scope(() => {
        this.saveTrainingLogits(this.current.index);
      });

      this.current.sampleCount += 1;
      this.currentSampleCallback(this.current.sampleCount);

      this.timer = requestAnimationFrame(this.animate.bind(this));
    } else if (this.getNumExamples() > 0) {
      const numExamples = this.getNumExamples();

      let measureTimer = false;
      let start = performance.now();
      measureTimer = this.measureTimingCounter === 0;

      const knn = this.math.scope(keep => {
        const frameLogits = this.captureFrameSqueezeNetLogits();

        if (this.trainLogitsMatrix === null) {
          let newTrainLogitsMatrix = null;

          for (let index = 0; index < CLASS_COUNT; index += 1) {
            newTrainLogitsMatrix = this.concat(newTrainLogitsMatrix, this.trainClassLogitsMatrices[index]);
          }

          this.trainLogitsMatrix = keep(this.math.clone(newTrainLogitsMatrix));
        }

        return this.math.matMul(this.trainLogitsMatrix.as2D(numExamples, 1000), frameLogits.as2D(1000, 1)).as1D();
      });

      const computeConfidences = () => {
        const kVal = Math.min(TOPK, numExamples);
        const topK = this.mathCPU.topK(knn, kVal);
        knn.dispose();

        const indices = topK.indices.getValues();

        const classTopKMap = [0, 0, 0];
        for (let index = 0; index < indices.length; index += 1) {
          classTopKMap[this.getClassFromIndex(indices[index])] += 1;
        }

        let confidences = [];
        for (let index = 0; index < CLASS_COUNT; index += 1) {
          const probability = classTopKMap[index] / kVal;
          confidences[index] = probability;
        }

        this.options.setConfidences(confidences);

        this.measureTimingCounter = (this.measureTimingCounter + 1) % MEASURE_TIMING_EVERY_NUM_FRAMES;

        this.timer = requestAnimationFrame(this.animate.bind(this));
      };

      if (!browserUtils.isSafari || measureTimer || !browserUtils.isMobile) {
        knn.getValuesAsync().then(() => {
          this.lastFrameTimeMs = performance.now() - start;
          computeConfidences();
        });
      } else {
        setTimeout(computeConfidences, this.lastFrameTimeMs);
      }
    } else {
      this.timer = requestAnimationFrame(this.animate.bind(this));
    }
  }

  getClassFromIndex(index) {
    let prevSum = 0;
    for (let ind = 0; ind < CLASS_COUNT; ind += 1) {
      if (index < this.classExampleCount[ind] + prevSum) {
        return ind;
      }
      prevSum += this.classExampleCount[ind];
    }

    return 2;
  }

  concat(ndarray1, ndarray2) {
    if (ndarray1 === null) {
      return ndarray2;
    } else if (ndarray2 === null) {
      return ndarray1;
    }
    const axis = 0;

    return this.math.concat3D(
      ndarray1.as3D(ndarray1.shape[0], INPUT_SIZE, 1),
      ndarray2.as3D(ndarray2.shape[0], INPUT_SIZE, 1),
      axis
    );
  }

  captureFrameSqueezeNetLogits() {
    const canvasTexture = this.math.getTextureManager().acquireTexture([IMAGE_SIZE, IMAGE_SIZE]);
    this.gpgpu.uploadPixelDataToTexture(canvasTexture, this.video);
    const preprocessedInput = this.math.track(
      this.squeezeNet.preprocessColorTextureToArray3D(canvasTexture, [IMAGE_SIZE, IMAGE_SIZE])
    );
    this.math.getTextureManager().releaseTexture(canvasTexture, [IMAGE_SIZE, IMAGE_SIZE]);

    // Infer through squeezenet.
    const inferenceResult = this.squeezeNet.infer(preprocessedInput);

    for (const key in inferenceResult.namedActivations) {
      if (key in inferenceResult.namedActivations) {
        this.math.track(inferenceResult.namedActivations[key]);
      }
    }

    const squashedLogits = this.math.divide(inferenceResult.logits, this.squashLogitsDenominator);

    // Normalize to unit length
    const squared = this.math.multiplyStrict(squashedLogits, squashedLogits);
    const sum = this.math.sum(squared);
    const sqrtSum = this.math.sqrt(sum);

    return this.math.divide(squashedLogits, sqrtSum);
  }
}

export default WebcamClassifier;
