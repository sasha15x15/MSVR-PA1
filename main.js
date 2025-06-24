'use strict';

let gl;                         // The webgl context.
let surface;                    // A surface model
let surfaceWebCam;              // A substrate for webcam image
let shProgram;                  // A shader program
let spaceball;                  // A SimpleRotator object that lets the user rotate the view by mouse.
let stereoCam;                  // Object holding stereo camera and its parameters

let iTextureWebCam = -1;

let video;

let sensorWebSocket = null;
let phoneRotationMatrix = m4.identity();
let usingPhoneOrientation = false;
let phoneIP = "192.168.50.230";
let phonePort = "8080";
let phoneDataReceived = false;


let smoothingFactor = 0.2;
let previousAccelData = [0, 0, 0];
let filteredAccelData = [0, 0, 0];
let smoothedMatrix = m4.identity();

function ShaderProgram(name, program) {
    this.name = name;
    this.prog = program;

    this.iAttribVertex = -1;
    this.iAttribTexCoord = -1;
    
    this.iColor = -1;
    this.iModelViewMatrix = -1;
    this.iProjectionMatrix = -1;
    this.iUseTexture = -1;
    this.iTexture = -1;

    this.Use = function() {
        gl.useProgram(this.prog);
    }
}

function smoothAccelData(newData) {
    for (let i = 0; i < 3; i++) {
        filteredAccelData[i] = smoothingFactor * newData[i] + (1 - smoothingFactor) * previousAccelData[i];
        previousAccelData[i] = filteredAccelData[i];
    }
    return filteredAccelData;
}

function getRotationMatrixFromAccelerometer(accelData) {
    try {
        const smoothedData = smoothAccelData(accelData);
        
        const ax = smoothedData[0];
        const ay = smoothedData[1];
        const az = smoothedData[2];
        
        const norm = Math.sqrt(ax*ax + ay*ay + az*az);
        if (norm === 0) return m4.identity();
        
        const ax_n = ax / norm;
        const ay_n = ay / norm;
        const az_n = az / norm;
        
        const pitch = Math.atan2(ay_n, az_n);
        const roll = Math.atan2(-ax_n, Math.sqrt(ay_n*ay_n + az_n*az_n));
        
        const rotX = m4.xRotation(pitch);
        const rotY = m4.yRotation(roll);
        
        const newMatrix = m4.multiply(rotX, rotY);
        
        if (!m4.equals(smoothedMatrix, m4.identity())) {
            for (let i = 0; i < 16; i++) {
                smoothedMatrix[i] = smoothingFactor * newMatrix[i] + (1 - smoothingFactor) * smoothedMatrix[i];
            }
            return smoothedMatrix;
        } else {
            smoothedMatrix = [...newMatrix];
            return newMatrix;
        }
    } catch (error) {
        console.error("Error in getRotationMatrixFromAccelerometer:", error);
        return m4.identity();
    }
}

if (!m4.equals) {
    m4.equals = function(m1, m2) {
        if (!m1 || !m2 || m1.length !== m2.length) return false;
        for (let i = 0; i < m1.length; i++) {
            if (Math.abs(m1[i] - m2[i]) > 0.000001) return false;
        }
        return true;
    };
}

function connectToSensorServer() {
    if (sensorWebSocket) {
        sensorWebSocket.close();
    }

    const ip = document.getElementById('phoneIP').value || phoneIP;
    const port = document.getElementById('phonePort').value || phonePort;
    const url = `ws://${ip}:${port}/sensor/connect?type=android.sensor.accelerometer`;

    console.log(`Connect to WebSocket by url: ${url}`);
    
    smoothedMatrix = m4.identity();
    previousAccelData = [0, 0, 0];
    filteredAccelData = [0, 0, 0];
    
    sensorWebSocket = new WebSocket(url);
    
    sensorWebSocket.onopen = function() {
        console.log('WebSocket connected');
        document.getElementById('connectionStatus').textContent = 'Connected';
        document.getElementById('connectionStatus').style.color = 'green';
        document.getElementById('connectButton').disabled = true;
        document.getElementById('disconnectButton').disabled = false;
        
        window.setTimeout(function() {
            if (!phoneDataReceived) {
                document.getElementById('connectionStatus').textContent = 'Connected, but no data';
                document.getElementById('connectionStatus').style.color = 'orange';
            }
        }, 3000);
    };
    
    sensorWebSocket.onmessage = function(event) {
        try {
            let sensorData;
            
            try {
                sensorData = JSON.parse(event.data);
            } catch (e) {
                console.log('Cannot parse data to JSON');
                return;
            }
            
            if (typeof sensorData === 'object' && !Array.isArray(sensorData)) {
                if (sensorData.values && Array.isArray(sensorData.values)) {
                    sensorData = sensorData.values;
                } else if (sensorData.data && Array.isArray(sensorData.data)) {
                    sensorData = sensorData.data;
                }
            }
            
            if (Array.isArray(sensorData) && sensorData.length >= 3) {
                console.log('Accelerator data:', sensorData);
                phoneDataReceived = true;
                usingPhoneOrientation = true;
                
                phoneRotationMatrix = getRotationMatrixFromAccelerometer(sensorData);
                
                document.getElementById('currentSensorData').textContent = `[${sensorData.map(v => v.toFixed(3)).join(', ')}]`;
            } else {
                console.warn('Wrong format data from accelerator:', sensorData);
            }
        } catch (error) {
            console.error('Error parse data:', error);
        }
    };
    
    sensorWebSocket.onerror = function(error) {
        console.error('Error WebSocket:', error);
        document.getElementById('connectionStatus').textContent = 'Connection error';
        document.getElementById('connectionStatus').style.color = 'red';
        document.getElementById('connectButton').disabled = false;
        document.getElementById('disconnectButton').disabled = true;
    };
    
    sensorWebSocket.onclose = function(event) {
        console.log(`WebSocket connection closed. Code: ${event.code}, Reason: ${event.reason}`);
        usingPhoneOrientation = false;
        phoneDataReceived = false;
        document.getElementById('connectionStatus').textContent = 'Disconnected';
        document.getElementById('connectionStatus').style.color = 'red';
        document.getElementById('connectButton').disabled = false;
        document.getElementById('disconnectButton').disabled = true;
    };
}

function disconnectFromSensorServer() {
    if (sensorWebSocket) {
        sensorWebSocket.close();
        usingPhoneOrientation = false;
        phoneDataReceived = false;
    }
}

function updateSmoothingFactor(event) {
    smoothingFactor = parseFloat(event.target.value);
    document.getElementById('smoothingValue').textContent = smoothingFactor.toFixed(2);
}

/* Draws a colored cube, along with a set of coordinate axes.
 * (Note that the use of the above drawPrimitive function is not an efficient
 * way to draw with WebGL.  Here, the geometry is so simple that it doesn't matter.)
 */
function draw() { 
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    let matrOrth = m4.orthographic(0, 1, 0, 1, -1, 1);
    const identityMV = m4.identity();
    
    gl.disable(gl.DEPTH_TEST);
    gl.colorMask(true, true, true, true);
    
    if (video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, iTextureWebCam);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    }
    
    gl.uniformMatrix4fv(shProgram.iProjectionMatrix, false, matrOrth);
    gl.uniformMatrix4fv(shProgram.iModelViewMatrix, false, identityMV);
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, iTextureWebCam);
    
    gl.uniform1i(shProgram.iTexture, 0);
    gl.uniform1i(shProgram.iUseTexture, 1);
    
    surfaceWebCam.Draw();
    
    gl.uniform1i(shProgram.iUseTexture, 0);
    
    gl.enable(gl.DEPTH_TEST);

    let modelView;
    if (usingPhoneOrientation && phoneDataReceived) {
        modelView = phoneRotationMatrix;
    } else {
        modelView = spaceball.getViewMatrix();
    }

    let rotateToPointZero = m4.axisRotation([0.707, 0.707, 0], 0.7);
    let translateToPointZero = m4.translation(0, 0, -10);

    const colorPolygon = new Float32Array([0.5, 0.5, 0.5, 1]);
    const colorEdge = new Float32Array([1, 1, 1, 1]);

    let matrLeftFrustum = stereoCam.calcLeftFrustum();
    gl.uniformMatrix4fv(shProgram.iProjectionMatrix, false, matrLeftFrustum);

    let translateLeftEye = m4.translation(stereoCam.eyeSeparation/2, 0, 0);

    let matAccum0 = m4.multiply(rotateToPointZero, modelView);
    let matAccum1 = m4.multiply(translateLeftEye, matAccum0);
    let matAccum2 = m4.multiply(translateToPointZero, matAccum1);
        
    gl.uniformMatrix4fv(shProgram.iModelViewMatrix, false, matAccum2);

    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1, 0);
    
    gl.colorMask(true, false, false, true);
    gl.uniform4fv(shProgram.iColor, colorPolygon);
    surface.Draw();
    gl.uniform4fv(shProgram.iColor, colorEdge);
    surface.DrawWireframe();

    gl.clear(gl.DEPTH_BUFFER_BIT);

    let matrRightFrustum = stereoCam.calcRightFrustum();
    gl.uniformMatrix4fv(shProgram.iProjectionMatrix, false, matrRightFrustum);

    let translateRightEye = m4.translation(-stereoCam.eyeSeparation/2, 0, 0);

    matAccum0 = m4.multiply(rotateToPointZero, modelView);
    matAccum1 = m4.multiply(translateRightEye, matAccum0);
    matAccum2 = m4.multiply(translateToPointZero, matAccum1);

    gl.uniformMatrix4fv(shProgram.iModelViewMatrix, false, matAccum2);

    gl.colorMask(false, true, true, true);
    gl.uniform4fv(shProgram.iColor, colorPolygon);
    surface.Draw();
    gl.uniform4fv(shProgram.iColor, colorEdge);
    surface.DrawWireframe();

    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.colorMask(true, true, true, true);
}

function CreateWebCamSurfaceData() {
    let data = {};
    
    data.verticesF32 = new Float32Array([
        0, 0, 0,
        1, 0, 0,
        1, 1, 0,
        0, 1, 0
    ]);
    
    data.texCoordsF32 = new Float32Array([
        1, 1,
        0, 1,
        0, 0,
        1, 0
    ]);
    
    data.indicesU16 = new Uint16Array([
        0, 1, 2,
        0, 2, 3
    ]);
    
    return data;
}


/* Initialize the WebGL context. Called from init() */
function initGL() {
    let prog = createProgram(gl, vertexShaderSource, fragmentShaderSource);
    shProgram = new ShaderProgram('Basic', prog);
    shProgram.Use();

    shProgram.iAttribVertex = gl.getAttribLocation(prog, "vertex");
    shProgram.iAttribTexCoord = gl.getAttribLocation(prog, "texCoord");
    
    shProgram.iModelViewMatrix = gl.getUniformLocation(prog, "ModelViewMatrix");
    shProgram.iProjectionMatrix = gl.getUniformLocation(prog, "ProjectionMatrix");
    shProgram.iColor = gl.getUniformLocation(prog, "color");
    shProgram.iTexture = gl.getUniformLocation(prog, "uTexture");
    shProgram.iUseTexture = gl.getUniformLocation(prog, "useTexture");

    // Set default texture values
    gl.uniform1i(shProgram.iTexture, 0); // Use texture unit 0
    gl.uniform1i(shProgram.iUseTexture, 0); // Disable texture by default

    let data = {};
    CreateCorrugatedSphere(data);
    surface = new Model('Surface');
    surface.BufferData(data.verticesF32, data.indicesU16);

    surfaceWebCam = new Model('SurfaceWebCam');
    surfaceWebCam.hasTexCoords = true;

    iTextureWebCam = CreateWebCamTexture(640, 480);

    gl.bindTexture(gl.TEXTURE_2D, iTextureWebCam);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const blackPixels = new Uint8Array([0, 0, 0, 255]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, blackPixels);

    if (shProgram.iAttribTexCoord >= 0) {
        gl.enableVertexAttribArray(shProgram.iAttribTexCoord);
    }

    let webcamData = CreateWebCamSurfaceData();
    surfaceWebCam.BufferData(webcamData.verticesF32, webcamData.indicesU16, webcamData.texCoordsF32);

    gl.bindBuffer(gl.ARRAY_BUFFER, surfaceWebCam.iTexCoordBuffer);
    gl.vertexAttribPointer(shProgram.iAttribTexCoord, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(shProgram.iAttribTexCoord);

    stereoCam = new StereoCamera(
        0.2,    // eye separation in decimeters
        14.0,   // convergence distance in decimeters
        1.3,    // aspect ratio of canvas
        0.4,    // FOV in radians
        8.0,    // near clipping distance in decimeters
        50.0    // far clipping distance in decimeters
    );

    gl.enable(gl.DEPTH_TEST);
}

function checkShaderCompilation(shader, type) {
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error(`Error compiling ${type} shader:`, gl.getShaderInfoLog(shader));
        return false;
    }
    return true;
}

/* Creates a program for use in the WebGL context gl, and returns the
 * identifier for that program.  If an error occurs while compiling or
 * linking the program, an exception of type Error is thrown.  The error
 * string contains the compilation or linking error.  If no error occurs,
 * the program identifier is the return value of the function.
 * The second and third parameters are strings that contain the
 * source code for the vertex shader and for the fragment shader.
 */
function createProgram(gl, vShader, fShader) {
    let vsh = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vsh, vShader);
    gl.compileShader(vsh);
    
    if (!checkShaderCompilation(vsh, "vertex")) {
        throw new Error("Error in vertex shader: " + gl.getShaderInfoLog(vsh));
    }
    
    let fsh = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fsh, fShader);
    gl.compileShader(fsh);
    
    if (!checkShaderCompilation(fsh, "fragment")) {
        throw new Error("Error in fragment shader: " + gl.getShaderInfoLog(fsh));
    }
    
    let prog = gl.createProgram();
    gl.attachShader(prog, vsh);
    gl.attachShader(prog, fsh);
    gl.linkProgram(prog);
    
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error("Link error in program: " + gl.getProgramInfoLog(prog));
    }
    
    return prog;
}

function CreateWebCamTexture(width, height) {
    let textureID = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, textureID);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    return textureID;
}

function init() {
    let canvas;
    try {
        canvas = document.getElementById("webglcanvas");
        gl = canvas.getContext("webgl");
        if (!gl) {
            throw "Browser does not support WebGL";
        }
    }
    catch (e) {
        document.getElementById("canvas-holder").innerHTML =
            "<p>Sorry, could not get a WebGL graphics context.</p>";
        return;
    }
    try {
        initGL();  // initialize the WebGL graphics context
    }
    catch (e) {
        document.getElementById("canvas-holder").innerHTML =
            "<p>Sorry, could not initialize the WebGL graphics context: " + e + "</p>";
        return;
    }

    initWebcam();

    document.getElementById('eyeSeparation').addEventListener('input', function(e) {
        stereoCam.eyeSeparation = parseFloat(e.target.value);
        document.getElementById('eyeSepValue').textContent = e.target.value;
    });
    
    document.getElementById('convergence').addEventListener('input', function(e) {
        stereoCam.convergence = parseFloat(e.target.value);
        document.getElementById('convergenceValue').textContent = e.target.value;
    });
    
    document.getElementById('fieldOfView').addEventListener('input', function(e) {
        stereoCam.FOV = parseFloat(e.target.value);
        document.getElementById('fovValue').textContent = e.target.value;
    });
    
    document.getElementById('smoothingFactor').addEventListener('input', updateSmoothingFactor);
    document.getElementById('connectButton').addEventListener('click', connectToSensorServer);
    document.getElementById('disconnectButton').addEventListener('click', disconnectFromSensorServer);
    document.getElementById('disconnectButton').disabled = true;
    
    spaceball = new TrackballRotator(canvas, draw, 0);

    function animationLoop() {
        draw();
        requestAnimationFrame(animationLoop);
    }
    
    requestAnimationFrame(animationLoop);
}

function initWebcam() {
    video = document.createElement('video');
    video.autoplay = true;
    video.muted = true; 
    video.playsInline = true;
    
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        navigator.mediaDevices.getUserMedia({ 
            video: { 
                width: { ideal: 640 },
                height: { ideal: 480 } 
            } 
        })
        .then(function(stream) {
            video.srcObject = stream;
            video.onloadedmetadata = function() {
                video.play().catch(function(err) {
                    console.error("Error starting video playback:", err);
                });
            };
        })
        .catch(function(err) {
            console.error("Error accessing camera:", err);
        });
    } else {
        console.error("getUserMedia not supported in this browser");
    }
}