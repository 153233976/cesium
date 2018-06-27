define([
        '../Core/arrayFill',
        '../Core/Check',
        '../Core/combine',
        '../Core/defaultValue',
        '../Core/defined',
        '../Core/defineProperties',
        '../Core/destroyObject',
        '../Core/getTimestamp',
        '../Core/JulianDate',
        '../Core/Math',
        '../Core/Matrix4',
        '../Core/Resource',
        './ClippingPlaneCollection',
        './PointCloud',
        './PointCloudEyeDomeLighting',
        './PointCloudShading',
        './SceneMode',
        './ShadowMode'
    ], function(
        arrayFill,
        Check,
        combine,
        defaultValue,
        defined,
        defineProperties,
        destroyObject,
        getTimestamp,
        JulianDate,
        CesiumMath,
        Matrix4,
        Resource,
        ClippingPlaneCollection,
        PointCloud,
        PointCloudEyeDomeLighting,
        PointCloudShading,
        SceneMode,
        ShadowMode) {
    'use strict';

    /**
     * Provides playback of time-dynamic point cloud data.
     * <p>
     * Point cloud frames are prefetched in intervals determined by the average frame load time and the current clock speed.
     * If intermediate frames cannot be loaded in time to meet playback speed, they will be skipped. If frames are sufficiently
     * small or the clock is sufficiently slow then no frames will be skipped.
     * </p>
     *
     * @alias TimeDynamicPointCloud
     * @constructor
     *
     * @param {Object} options Object with the following properties:
     * @param {Clock} options.clock A {@link Clock} instance that is used when determining the value for the time dimension.
     * @param {TimeIntervalCollection} options.intervals A {@link TimeIntervalCollection} with its data property being an object containing a <code>uri</code> to a 3D Tiles Point Cloud tile and an optional <code>transform</code>.
     * @param {Boolean} [options.show=true] Determines if the point cloud will be shown.
     * @param {Matrix4} [options.modelMatrix=Matrix4.IDENTITY] A 4x4 transformation matrix that transforms the point cloud.
     * @param {ShadowMode} [options.shadows=ShadowMode.ENABLED] Determines whether the point cloud casts or receives shadows from each light source.
     * @param {Number} [options.maximumMemoryUsage=256] The maximum amount of memory in MB that can be used by the point cloud.
     * @param {Object} [options.pointCloudShading] Options for constructing a {@link PointCloudShading} object to control point attenuation and eye dome lighting.
     * @param {Cesium3DTileStyle} [options.style] The style, defined using the {@link https://github.com/AnalyticalGraphicsInc/3d-tiles/tree/master/Styling|3D Tiles Styling language}, applied to each point in the point cloud.
     * @param {ClippingPlaneCollection} [options.clippingPlanes] The {@link ClippingPlaneCollection} used to selectively disable rendering the point cloud.
     */
    function TimeDynamicPointCloud(options) {
        options = defaultValue(options, defaultValue.EMPTY_OBJECT);

        //>>includeStart('debug', pragmas.debug);
        Check.typeOf.object('options.clock', options.clock);
        Check.typeOf.object('options.intervals', options.intervals);
        //>>includeEnd('debug');

        /**
         * Determines if the point cloud will be shown.
         *
         * @type {Boolean}
         * @default true
         */
        this.show = defaultValue(options.show, true);

        /**
         * A 4x4 transformation matrix that transforms the point cloud.
         *
         * @type {Matrix4}
         * @default Matrix4.IDENTITY
         */
        this.modelMatrix = Matrix4.clone(defaultValue(options.modelMatrix, Matrix4.IDENTITY));

        /**
         * Determines whether the point cloud casts or receives shadows from each light source.
         * <p>
         * Enabling shadows has a performance impact. A point cloud that casts shadows must be rendered twice, once from the camera and again from the light's point of view.
         * </p>
         * <p>
         * Shadows are rendered only when {@link Viewer#shadows} is <code>true</code>.
         * </p>
         *
         * @type {ShadowMode}
         * @default ShadowMode.ENABLED
         */
        this.shadows = defaultValue(options.shadows, ShadowMode.ENABLED);

        /**
         * The maximum amount of GPU memory (in MB) that may be used to cache point cloud frames.
         * <p>
         * Frames that are not being loaded or rendered are unloaded to enforce this.
         * </p>
         * <p>
         * If decreasing this value results in unloading tiles, the tiles are unloaded the next frame.
         * </p>
         * @memberof TimeDynamicPointCloud.prototype
         *
         * @type {Number}
         * @default 256
         *
         * @see TimeDynamicPointCloud#totalMemoryUsageInBytes
         */
        this.maximumMemoryUsage = defaultValue(options.maximumMemoryUsage, 256);

        /**
         * Options for controlling point size based on geometric error and eye dome lighting.
         * @type {PointCloudShading}
         */
        this.pointCloudShading = new PointCloudShading(options.pointCloudShading);

        /**
         * The style, defined using the
         * {@link https://github.com/AnalyticalGraphicsInc/3d-tiles/tree/master/Styling|3D Tiles Styling language},
         * applied to each point in the point cloud.
         * <p>
         * Assign <code>undefined</code> to remove the style, which will restore the visual
         * appearance of the point cloud to its default when no style was applied.
         * </p>
         *
         * @type {Cesium3DTileStyle}
         *
         * @example
         * pointCloud.style = new Cesium.Cesium3DTileStyle({
         *    color : {
         *        conditions : [
         *            ['${Classification} === 0', 'color("purple", 0.5)'],
         *            ['${Classification} === 1', 'color("red")'],
         *            ['true', '${COLOR}']
         *        ]
         *    },
         *    show : '${Classification} !== 2'
         * });
         *
         * @see {@link https://github.com/AnalyticalGraphicsInc/3d-tiles/tree/master/Styling|3D Tiles Styling language}
         */
        this.style = options.style;

        this._clock = options.clock;
        this._intervals = options.intervals;
        this._clippingPlanes = options.clippingPlanes;
        this._pointCloudEyeDomeLighting = new PointCloudEyeDomeLighting();
        this._loadTimestamp = undefined;
        this._clippingPlanesState = 0;
        this._styleDirty = false;
        this._pickId = undefined;
        this._totalMemoryUsageInBytes = 0;
        this._frames = [];
        this._previousInterval = undefined;
        this._nextInterval = undefined;
        this._lastRenderedFrame = undefined;
        this._clockMultiplier = 0.0;

        // For calculating average load time of the last N frames
        this._runningSum = 0.0;
        this._runningLength = 0;
        this._runningIndex = 0;
        this._runningSamples = arrayFill(new Array(5), 0.0);
        this._runningAverage = 0.0;
    }

    defineProperties(TimeDynamicPointCloud.prototype, {
        /**
         * The {@link ClippingPlaneCollection} used to selectively disable rendering the point cloud.
         *
         * @memberof TimeDynamicPointCloud.prototype
         *
         * @type {ClippingPlaneCollection}
         */
        clippingPlanes : {
            get : function() {
                return this._clippingPlanes;
            },
            set : function(value) {
                ClippingPlaneCollection.setOwner(value, this, '_clippingPlanes');
            }
        },

        /**
         * The total amount of GPU memory in bytes used by the point cloud.
         *
         * @memberof TimeDynamicPointCloud.prototype
         *
         * @type {Number}
         * @readonly
         *
         * @see TimeDynamicPointCloud#maximumMemoryUsage
         */
        totalMemoryUsageInBytes : {
            get : function() {
                return this._totalMemoryUsageInBytes;
            }
        }
    });

    function getFragmentShaderLoaded(fs) {
        return 'uniform vec4 czm_pickColor;\n' + fs;
    }

    function getUniformMapLoaded(stream) {
        return function(uniformMap) {
            return combine(uniformMap, {
                czm_pickColor : function() {
                    return stream._pickId.color;
                }
            });
        };
    }

    function getPickIdLoaded() {
        return 'czm_pickColor';
    }

    /**
     * Marks the point cloud's {@link TimeDynamicPointCloud#style} as dirty, which forces all
     * points to re-evaluate the style in the next frame.
     */
    TimeDynamicPointCloud.prototype.makeStyleDirty = function() {
        this._styleDirty = true;
    };

    function getAverageLoadTime(that) {
        if (that._runningLength === 0) {
            // Before any frames have loaded make a best guess about the average load time
            return 0.05;
        }
        return that._runningAverage;
    }

    var scratchDate = new JulianDate();

    function getClockMultiplier(that) {
        var clock = that._clock;
        var isAnimating = clock.canAnimate && clock.shouldAnimate;
        var multiplier = clock.multiplier;
        return isAnimating ? multiplier : 0.0;
    }

    function getIntervalIndex(that, interval) {
        return that._intervals.indexOf(interval.start);
    }

    function getNextInterval(that, currentInterval) {
        var intervals = that._intervals;
        var clock = that._clock;
        var multiplier = getClockMultiplier(that);

        if (multiplier === 0.0) {
            return undefined;
        }

        var averageLoadTime = getAverageLoadTime(that);
        var time = JulianDate.addSeconds(clock.currentTime, averageLoadTime * multiplier, scratchDate);
        var index = intervals.indexOf(time);

        var currentIndex = getIntervalIndex(that, currentInterval);
        if (index === currentIndex) {
            if (multiplier >= 0) {
                ++index;
            } else {
                --index;
            }
        }

        // Returns undefined if not in range
        return intervals.get(index);
    }

    function getCurrentInterval(that) {
        var intervals = that._intervals;
        var clock = that._clock;
        var time = clock.currentTime;
        var index = intervals.indexOf(time);

        // Returns undefined if not in range
        return intervals.get(index);
    }

    function reachedInterval(that, currentInterval, nextInterval) {
        var multiplier = getClockMultiplier(that);
        var currentIndex = getIntervalIndex(that, currentInterval);
        var nextIndex = getIntervalIndex(that, nextInterval);

        if (multiplier >= 0) {
            return currentIndex >= nextIndex;
        }
        return currentIndex <= nextIndex;
    }

    function requestFrame(that, interval, frameState) {
        var index = getIntervalIndex(that, interval);
        var frames = that._frames;
        var frame = frames[index];
        if (!defined(frame)) {
            var transformArray = interval.data.transform;
            var transform = defined(transformArray) ? Matrix4.fromArray(transformArray) : undefined;
            frame = {
                pointCloud : undefined,
                transform : transform,
                timestamp : getTimestamp(),
                sequential : true,
                ready : false,
                touchedFrameNumber : frameState.frameNumber
            };
            frames[index] = frame;
            Resource.fetchArrayBuffer({
                url : interval.data.uri
            }).then(function(arrayBuffer) {
                // PERFORMANCE_IDEA: share a memory pool, render states, shaders, and other resources among all
                // frames. Each frame just needs an index/offset into the pool.
                frame.pointCloud = new PointCloud({
                    arrayBuffer : arrayBuffer,
                    cull : true,
                    fragmentShaderLoaded : getFragmentShaderLoaded,
                    uniformMapLoaded : getUniformMapLoaded(that),
                    pickIdLoaded : getPickIdLoaded
                });
            }).otherwise(function(error) {
                throw error;
            });
        }
        return frame;
    }

    function updateAverageLoadTime(that, loadTime) {
        that._runningSum += loadTime;
        that._runningSum -= that._runningSamples[that._runningIndex];
        that._runningSamples[that._runningIndex] = loadTime;
        that._runningLength = Math.min(that._runningLength + 1, that._runningSamples.length);
        that._runningIndex = (that._runningIndex + 1) % that._runningSamples.length;
        that._runningAverage = that._runningSum / that._runningLength;
    }

    function prepareFrame(that, frame, frameState) {
        if (frame.touchedFrameNumber < frameState.frameNumber - 1) {
            // If this frame was not loaded in sequential updates then it can't be used it for calculating the average load time.
            // For example: selecting a frame on the timeline, selecting another frame before the request finishes, then selecting this frame later.
            frame.sequential = false;
        }

        var pointCloud = frame.pointCloud;

        if (defined(pointCloud) && !frame.ready) {
            // Call update to prepare renderer resources. Don't render anything yet.
            var commandList = frameState.commandList;
            var lengthBeforeUpdate = commandList.length;
            pointCloud.update(frameState);

            if (pointCloud.ready) {
                // Point cloud became ready this update
                frame.ready = true;
                that._totalMemoryUsageInBytes += pointCloud.geometryByteLength;
                commandList.length = lengthBeforeUpdate; // Don't allow preparing frame to insert commands.
                if (frame.sequential) {
                    // Update the values used to calculate average load time
                    var loadTime = (getTimestamp() - frame.timestamp) / 1000.0;
                    updateAverageLoadTime(that, loadTime);
                }
            }
        }

        frame.touchedFrameNumber = frameState.frameNumber;
    }

    var scratchModelMatrix = new Matrix4();

    function getGeometricError(that, pointCloud) {
        var pointCloudShading = that.pointCloudShading;
        if (defined(pointCloudShading) && defined(pointCloudShading.baseResolution)) {
            return pointCloudShading.baseResolution;
        }
        return CesiumMath.cbrt(pointCloud.boundingSphere.volume() / pointCloud.pointsLength);
    }

    function getMaximumAttenuation(that) {
        var pointCloudShading = that.pointCloudShading;
        if (defined(pointCloudShading) && defined(pointCloudShading.maximumAttenuation)) {
            return pointCloudShading.maximumAttenuation;
        }

        // Return a hardcoded maximum attenuation. For a tileset this would instead be the maximum screen space error.
        return 10.0;
    }

    function renderFrame(that, frame, timeSinceLoad, isClipped, clippingPlanesDirty, frameState) {
        var pointCloud = frame.pointCloud;
        var transform = defaultValue(frame.transform, Matrix4.IDENTITY);
        pointCloud.modelMatrix = Matrix4.multiplyTransformation(that.modelMatrix, transform, scratchModelMatrix);
        pointCloud.style = that.style;
        pointCloud.styleDirty = that._styleDirty;
        pointCloud.time = timeSinceLoad;
        pointCloud.shadows = that.shadows;
        pointCloud.clippingPlanes = that._clippingPlanes;
        pointCloud.isClipped = isClipped;
        pointCloud.clippingPlanesDirty = clippingPlanesDirty;

        var pointCloudShading = that.pointCloudShading;
        if (defined(pointCloudShading)) {
            pointCloud.attenuation = pointCloudShading.attenuation;
            pointCloud.geometricError = getGeometricError(that, pointCloud);
            pointCloud.geometricErrorScale = pointCloudShading.geometricErrorScale;
            pointCloud.maximumAttenuation = getMaximumAttenuation(that);
        }
        pointCloud.update(frameState);
        frame.touchedFrameNumber = frameState.frameNumber;
    }

    function loadFrame(that, interval, frameState) {
        var frame = requestFrame(that, interval, frameState);
        prepareFrame(that, frame, frameState);
    }

    function getUnloadCondition(frameState) {
        return function(frame) {
            // Unload all frames that aren't currently being loaded or rendered
            return frame.touchedFrameNumber < frameState.frameNumber;
        };
    }

    function unloadFrames(that, unloadCondition) {
        var frames = that._frames;
        var length = frames.length;
        for (var i = 0; i < length; ++i) {
            var frame = frames[i];
            if (defined(frame)) {
                if (!defined(unloadCondition) || unloadCondition(frame)) {
                    var pointCloud = frame.pointCloud;
                    if (frame.ready) {
                        that._totalMemoryUsageInBytes -= pointCloud.geometryByteLength;
                    }
                    if (defined(pointCloud)) {
                        pointCloud.destroy();
                    }
                    if (frame === that._lastRenderedFrame) {
                        that._lastRenderedFrame = undefined;
                    }
                    frames[i] = undefined;
                }
            }
        }
    }

    function getFrame(that, interval) {
        var index = getIntervalIndex(that, interval);
        var frame = that._frames[index];
        if (defined(frame) && frame.ready) {
            return frame;
        }
    }

    function updateInterval(that, interval, frame, frameState) {
        if (defined(frame)) {
            if (frame.ready) {
                return true;
            }
            loadFrame(that, interval, frameState);
            return frame.ready;
        }
        return false;
    }

    function getNearestReadyInterval(that, previousInterval, currentInterval, frameState) {
        var i;
        var interval;
        var frame;
        var intervals = that._intervals;
        var frames = that._frames;
        var currentIndex = getIntervalIndex(that, currentInterval);
        var previousIndex = getIntervalIndex(that, previousInterval);

        if (currentIndex >= previousIndex) { // look backwards
            for (i = currentIndex; i >= previousIndex; --i) {
                interval = intervals.get(i);
                frame = frames[i];
                if (updateInterval(that, interval, frame, frameState)) {
                    return interval;
                }
            }
        } else { // look forwards
            for (i = currentIndex; i <= previousIndex; ++i) {
                interval = intervals.get(i);
                frame = frames[i];
                if (updateInterval(that, interval, frame, frameState)) {
                    return interval;
                }
            }
        }

        // If no intervals are ready return the previous interval
        return previousInterval;
    }

    TimeDynamicPointCloud.prototype.update = function(frameState) {
        if (frameState.mode === SceneMode.MORPHING) {
            return;
        }

        if (!this.show) {
            return;
        }

        if (!defined(this._pickId)) {
            this._pickId = frameState.context.createPickId({
                primitive : this
            });
        }

        if (!defined(this._loadTimestamp)) {
            this._loadTimestamp = JulianDate.clone(frameState.time);
        }

        // For styling
        var timeSinceLoad = Math.max(JulianDate.secondsDifference(frameState.time, this._loadTimestamp) * 1000, 0.0);

        // Update clipping planes
        var clippingPlanes = this._clippingPlanes;
        var clippingPlanesState = 0;
        var clippingPlanesDirty = false;
        var isClipped = defined(clippingPlanes) && clippingPlanes.enabled;

        if (isClipped) {
            clippingPlanes.update(frameState);
            clippingPlanesState = clippingPlanes.clippingPlanesState;
        }

        if (this._clippingPlanesState !== clippingPlanesState) {
            this._clippingPlanesState = clippingPlanesState;
            clippingPlanesDirty = true;
        }

        var pointCloudShading = this.pointCloudShading;
        var eyeDomeLighting = this._pointCloudEyeDomeLighting;

        var commandList = frameState.commandList;
        var lengthBeforeUpdate = commandList.length;

        var previousInterval = this._previousInterval;
        var nextInterval = this._nextInterval;
        var currentInterval = getCurrentInterval(this);

        if (!defined(currentInterval)) {
            return;
        }

        var clockMultiplierChanged = false;
        var clockMultiplier = getClockMultiplier(this);
        var clockPaused = clockMultiplier === 0;
        if (clockMultiplier !== this._clockMultiplier) {
            clockMultiplierChanged  = true;
            this._clockMultiplier = clockMultiplier;
        }

        if (!defined(previousInterval) || clockPaused) {
            previousInterval = currentInterval;
        }

        if (!defined(nextInterval) || clockMultiplierChanged || reachedInterval(this, currentInterval, nextInterval)) {
            nextInterval = getNextInterval(this, currentInterval);
        }

        previousInterval = getNearestReadyInterval(this, previousInterval, currentInterval, frameState);
        var frame = getFrame(this, previousInterval);

        if (!defined(frame)) {
            // The frame is not ready to render. This can happen when the simulation starts or when scrubbing the timeline
            // to a frame that hasn't loaded yet. Just render the last rendered frame in its place until it finishes loading.
            loadFrame(this, previousInterval, frameState);
            frame = this._lastRenderedFrame;
        }

        if (defined(frame)) {
            renderFrame(this, frame, timeSinceLoad, isClipped, clippingPlanesDirty, frameState);
        }

        if (defined(nextInterval)) {
            // Start loading the next frame
            loadFrame(this, nextInterval, frameState);
        }

        this._previousInterval = previousInterval;
        this._nextInterval = nextInterval;
        this._lastRenderedFrame = frame;

        var totalMemoryUsageInBytes = this._totalMemoryUsageInBytes;
        var maximumMemoryUsageInBytes = this.maximumMemoryUsage * 1024 * 1024;

        if (totalMemoryUsageInBytes > maximumMemoryUsageInBytes) {
            unloadFrames(this, getUnloadCondition(frameState));
        }

        var lengthAfterUpdate = commandList.length;
        var addedCommandsLength = lengthAfterUpdate - lengthBeforeUpdate;

        if (defined(pointCloudShading) && pointCloudShading.attenuation && pointCloudShading.eyeDomeLighting && (addedCommandsLength > 0)) {
            eyeDomeLighting.update(frameState, lengthBeforeUpdate, pointCloudShading);
        }
    };

    TimeDynamicPointCloud.prototype.isDestroyed = function() {
        return false;
    };

    TimeDynamicPointCloud.prototype.destroy = function() {
        unloadFrames(this);
        this._clippingPlanes = this._clippingPlanes && this._clippingPlanes.destroy();
        this._pickId = this._pickId && this._pickId.destroy();
        return destroyObject(this);
    };

    return TimeDynamicPointCloud;
});
