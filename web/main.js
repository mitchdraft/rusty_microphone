// This is read and used by `rusty_microphone.js`
var mod = null;

var env = {
    log2f: Math.log2,
    roundf: Math.round
};

checkBrowserSupport(function() {
    fetch('rusty_microphone.wasm')
        .then(response => response.arrayBuffer())
        .then(bytes => WebAssembly.instantiate(bytes, { env:env }))
        .then(results => {
            mod = results.instance;
            main();
        });
});

function supportsWasm() {
    return typeof WebAssembly === 'object';
}

function supportsUserMedia() {
    return typeof navigator === 'object' &&
        typeof navigator.mediaDevices === 'object' &&
        typeof navigator.mediaDevices.getUserMedia === 'function' &&
        typeof AudioContext === "function";
}

function checkBrowserSupport(supportedCallback) {
    if (!supportsWasm() || !supportsUserMedia()) {
        document.getElementById('loading').setAttribute('style', 'display:none');
        document.getElementById('browser-support-error').removeAttribute('style');
    }
    else {
        supportedCallback();
    }
}

/**
 * Puts at javascript float array onto the heap and provides a pointer
 *
 * Webassembly's input types are limited to integers and floating
 * point numbers. You can get around this limitation by putting the
 * data you want (a f32 array in this case) onto the heap, and passing
 * Webassembly a pointer and length. A callback is used for the actual
 * Webassembly call so that the heap memory can be automatically freed
 * afterwards.
 *
 * @param {array} jsArray - A javascript array, or Float32Array, of numbers
 * @param {function} callback - The function to call with a pointer and length of the array
 */
function jsArrayToF32ArrayPtr(jsArray, callback) {
    var data = (jsArray instanceof Float32Array) ? jsArray : new Float32Array(jsArray);
    var nDataBytes = data.length * data.BYTES_PER_ELEMENT;
    var dataPtr = mod.exports.malloc(nDataBytes);

    var dataHeap = new Uint8Array(mod.exports.memory.buffer, dataPtr, nDataBytes);
    dataHeap.set(new Uint8Array(data.buffer));

    var result = callback(dataPtr, jsArray.length);

    mod.exports.free(dataPtr, nDataBytes);
    
    return result;
}

/**
 * Puts at javascript float array onto the heap and provides a pointer, for functions that mutate the array in place
 *
 * Webassembly's input types are limited to integers and floating
 * point numbers. You can get around this limitation by putting the
 * data you want (a f32 array in this case) onto the heap, and passing
 * Webassembly a pointer and length. In this case, we also want to
 * return an array of the same lenght, so our Webassembly function
 * mutates the input array in place. A callback is used for the actual
 * Webassembly call so that the heap memory can be automatically freed
 * afterwards.
 *
 * @param {array} jsArray - A javascript array, or Float32Array, of numbers
 * @param {function} callback - The function to call with a pointer and length of the array
 */
function jsArrayToF32ArrayPtrMutateInPlace(jsArray, mutate) {
    var data = new Float32Array(jsArray);
    var nDataBytes = data.length * data.BYTES_PER_ELEMENT;
    var dataPtr = mod.exports.malloc(nDataBytes);

    var dataHeap = new Uint8Array(mod.exports.memory.buffer, dataPtr, nDataBytes);
    dataHeap.set(new Uint8Array(data.buffer));

    mutate(dataPtr, jsArray.length);

    var mutatedData = new Float32Array(mod.exports.memory.buffer, dataPtr, jsArray.length);
    var result = Array.prototype.slice.call(mutatedData);
    
    mod.exports.free(dataPtr, nDataBytes);
    
    return result;
}

function findFundamentalFrequency(data, samplingRate) {
    return jsArrayToF32ArrayPtr(data, function(dataPtr, dataLength) {
        return mod.exports.find_fundamental_frequency(dataPtr, dataLength, samplingRate);
    });
}

var nDataBytes = null;
var dataPtr = null;
var dataHeap = null;
/**
 * Does the same thing as findFundamentalFrequency, except
 * 1. assumes the array is already a Float32Array
 * 2. assumes that the array will always be the same length of subsequent calls
 * 3. does not free the allocated memory on the heap
 * 4. reuses the allocated heap memory on subsequent calls
 */
function findFundamentalFrequencyNoFree(data, samplingRate) {
    if (!dataPtr) {
        nDataBytes = data.length * data.BYTES_PER_ELEMENT;
        dataPtr = mod.exports.malloc(nDataBytes);
        dataHeap = new Uint8Array(mod.exports.memory.buffer, dataPtr, nDataBytes);
    }
    dataHeap.set(new Uint8Array(data.buffer, data.buffer.byteLength - nDataBytes));
    return mod.exports.find_fundamental_frequency(dataPtr, data.length, samplingRate);    
}

/**
 * Takes a pointer to a C-style string (ends in a 0), and interprets it as UTF-8.
 */
function copyCStr(ptr) {
    var iter = ptr;

    // ye olde 0 terminated string
    function* collectCString() {
        var memory = new Uint8Array(mod.exports.memory.buffer);
        while (memory[iter] !== 0) {
            if (memory[iter] === undefined) {
                throw new Error("Tried to read undef mem");
            }
            yield memory[iter];
            iter += 1;
        }
    };

    var buffer_as_u8 = new Uint8Array(collectCString());
    var utf8Decoder = new TextDecoder("UTF-8");
    var buffer_as_utf8 = utf8Decoder.decode(buffer_as_u8);
    mod.exports.free_str(ptr);
    return buffer_as_utf8;
}


function hzToCentsError(hz) {
    return mod.exports.hz_to_cents_error(hz);
}

function hzToPitch(hz) {
    var strPtr = mod.exports.hz_to_pitch(hz);
    return copyCStr(strPtr);
};

function correlation(data, samplingRate) {
    return jsArrayToF32ArrayPtrMutateInPlace(data, function(dataPtr, dataLength) {
        mod.exports.correlation(dataPtr, dataLength, samplingRate);
    });
}

function update(view, signal, sampleRate, timestamp) {
    var fundamental = findFundamentalFrequencyNoFree(signal, sampleRate);

    var pitch = hzToPitch(fundamental);
    var error = hzToCentsError(fundamental);

    view.draw(signal, timestamp, pitch, error);
}

function initView() {
    var canvas = document.getElementById("oscilloscope");
    var canvasCtx = canvas.getContext("2d");

    var frameRateLabel = document.getElementById('frame-rate');

    var pitchLabel = document.getElementById('pitch-label');

    var pitchIndicatorBar = document.getElementById('pitch-indicator-bar');
    var flatIndicator = document.getElementById('flat-indicator');
    var sharpIndicator = document.getElementById('sharp-indicator');
    
    var lastTimestamp = 0;
    var timestampMod = 0;

    document.getElementById('loading').setAttribute('style', 'display: none');
    document.getElementById('browser-support-error').setAttribute('style', 'display: none');
    document.getElementById('unexpected-error').setAttribute('style', 'display: none');
    document.getElementById('rusty-microphone').removeAttribute('style');
    drawDebugGraph([]);

    function draw(signal, timestamp, pitch, error) {
        drawDebugGraph(signal);
        updatePitchIndicators(pitch, error);
        updateFramerate(timestamp);
    }

    function updateFramerate(timestamp) {
        timestampMod += 1;
        if (timestampMod === 100) {
            timestampMod = 0;
            var dt = timestamp - lastTimestamp;
            lastTimestamp = timestamp;
            var framerate = 100000/dt;
            frameRateLabel.innerText = framerate.toFixed(2);
        }
    }

    function updatePitchIndicators(pitch, error) {
        pitchLabel.innerText = pitch;

        if (isNaN(error)) {
            pitchIndicatorBar.setAttribute('style', 'visibility: hidden');
        } else {
            var sharpColour;
            var flatColour;

            if (error > 0) {
                sharpColour = Math.floor(256*error/50);
                flatColour = 0;
            } else {
                sharpColour = 0;
                flatColour = Math.floor(-256*error/50);
            }
            flatIndicator.setAttribute('style', 'background: rgb(0,0,'+flatColour+')');
            sharpIndicator.setAttribute('style', 'background: rgb('+sharpColour+',0,0)');

            var errorIndicatorPercentage = error+50;
            pitchIndicatorBar.setAttribute('style', 'left: ' + errorIndicatorPercentage.toFixed(2) + '%');
        }
    }
    
    function drawDebugGraph(signal) {
        // This draw function is heavily based on an example from MDN:
        // https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode

        canvasCtx.fillStyle = 'rgb(200, 200, 200)';
        canvasCtx.fillRect(0, 0, canvas.width, canvas.height);

        canvasCtx.lineWidth = 2;
        canvasCtx.strokeStyle = 'rgb(0, 0, 0)';

        canvasCtx.beginPath();

        for (var i = 0; i < signal.length; i++) {
            var y = (signal[i] * canvas.height / 2) + canvas.height / 2;
            var x = i * canvas.width / signal.length;

            if (i === 0) {
                canvasCtx.moveTo(x, y);
            } else {
                canvasCtx.lineTo(x, y);
            }
        }

        canvasCtx.stroke();
    };

    return {
        draw: draw
    };
}


function main() {
    var view = initView();

    document.getElementById('start-button').addEventListener('click', start);
    
    function start() {
        document.getElementById('start-button').remove();
        
        navigator.mediaDevices.getUserMedia({ audio: true })
            .then(function(stream) {
                var context = new AudioContext();
                var input = context.createMediaStreamSource(stream);
                var analyser = context.createAnalyser();
                analyser.fftSize = 512;
                analyser.smoothingTimeConstant = 0;
                input.connect(analyser);

                var dataArray = new Float32Array(analyser.fftSize);

                function analyserNodeCallback(timestamp) {
                    analyser.getFloatTimeDomainData(dataArray);
                    update(view, dataArray, context.sampleRate, timestamp);
                    window.requestAnimationFrame(analyserNodeCallback);
                }

                window.requestAnimationFrame(analyserNodeCallback);
            })
            .catch(function(err) {
                document.getElementById('loading').setAttribute('style', 'display:none');
                document.getElementById('unexpected-error').removeAttribute('style');
            });
    }

}
