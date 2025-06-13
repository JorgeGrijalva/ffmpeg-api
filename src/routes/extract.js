var express = require("express");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const uniqueFilename = require("unique-filename");
var archiver = require("archiver");

const constants = require("../constants.js");
const logger = require("../utils/logger.js");
const utils = require("../utils/utils.js");

var router = express.Router();

//routes for /video/extract
//extracts audio from video
//extracts images from vide
router.post("/audio", function (req, res, next) {
  res.locals.extract = "audio";
  return extract(req, res, next);
});

router.post("/images", function (req, res, next) {
  res.locals.extract = "images";
  return extract(req, res, next);
});

router.get("/download/:filename", function (req, res, next) {
  //download extracted image
  let filename = req.params.filename;
  let file = `/tmp/${filename}`;
  return utils.downloadFile(file, null, req, res, next);
});

// extract audio or images from video
function extract(req, res, next) {
let extract = res.locals.extract;
  console.log(`Processing extraction: ${extract}`);
  logger.debug(`extract ${extract}`);

  let fps = req.query.fps || 1;
  //compress = zip or gzip
  let compress = req.query.compress || "none";
  let ffmpegParams = {};
  var format = "png";
  if (extract === "images") {
    format = "png";
    ffmpegParams.outputOptions = [`-vf fps=${fps}`];
  }
  if (extract === "audio") {
    format = "mp3";
    ffmpegParams.outputOptions = ["-ac 1", "-codec:a libmp3lame", "-b:a 32k"];
    logger.debug("extracting audio with low bitrate, 1 channel");
  }

  ffmpegParams.extension = format;

  let savedFile = res.locals.savedFile;
  if (!savedFile) {
    console.error("Multipart: Boundary not found");
    return res.status(400).send({ error: "Multipart: Boundary not found" });
  }
  if (res.locals.extract === "audio") {
    try {
      let stats = fs.statSync(savedFile);
      console.log(`Audio extraction - input file size: ${stats.size} bytes`);
    } catch(err) {
      console.error(`Error getting file stats: ${err}`);
    }
  }

  var outputFile = uniqueFilename("/tmp/");
  logger.debug(`outputFile ${outputFile}`);
  var uniqueFileNamePrefix = outputFile.replace("/tmp/", "");
  logger.debug(`uniqueFileNamePrefix ${uniqueFileNamePrefix}`);

  //ffmpeg processing...
var ffmpegCommand = ffmpeg(savedFile);
  ffmpegCommand = ffmpegCommand
    .renice(constants.defaultFFMPEGProcessPriority)
    .inputOptions(["-fflags", "+genpts"])
    .outputOptions(ffmpegParams.outputOptions)
.on("error", function (err) {
      logger.error(`${err}`);
      console.error(`ffmpeg error: ${err}`);
      utils.deleteFile(savedFile);
      res.writeHead(500, { Connection: "close" });
      res.end(JSON.stringify({ error: `${err}` }));
    });

  //extract audio track from video as wav
if (extract === "audio") {
    let audioFile = `${outputFile}.mp3`;
    ffmpegCommand
      .format("mp3")
      .on("end", function () {
        console.log(`Audio extraction ended`);
        logger.debug(`ffmpeg process ended`);

        utils.deleteFile(savedFile);
        return utils.downloadFile(audioFile, null, req, res, next);
      })
      .save(audioFile);
  }

  //extract png images from video
  if (extract === "images") {
    ffmpegCommand
      .output(`${outputFile}-%04d.png`)
.on("end", function () {
        console.log(`Images extraction ended`);
        logger.debug(`ffmpeg process ended`);

        utils.deleteFile(savedFile);

        //read extracted files
        var files = fs
          .readdirSync("/tmp/")
          .filter((fn) => fn.startsWith(uniqueFileNamePrefix));

        if (compress === "zip" || compress === "gzip") {
          //do zip or tar&gzip of all images and download file
          var archive = null;
          var extension = "";
          if (compress === "gzip") {
            archive = archiver("tar", {
              gzip: true,
              zlib: { level: 9 }, // Sets the compression level.
            });
            extension = "tar.gz";
          } else {
            archive = archiver("zip", {
              zlib: { level: 9 }, // Sets the compression level.
            });
            extension = "zip";
          }

          let compressFileName = `${uniqueFileNamePrefix}.${extension}`;
          let compressFilePath = `/tmp/${compressFileName}`;
          logger.debug(`starting ${compress} process ${compressFilePath}`);
          var compressFile = fs.createWriteStream(compressFilePath);

          archive.on("error", function (err) {
            return next(err);
          });

          // pipe archive data to the output file
          archive.pipe(compressFile);

          // add files to archive
          for (var i = 0; i < files.length; i++) {
            var file = `/tmp/${files[i]}`;
            archive.file(file, { name: files[i] });
          }

          // listen for all archive data to be written
          // 'close' event is fired only when a file descriptor is involved
          compressFile.on("close", function () {
            logger.debug(
              `${compressFileName}: ${archive.pointer()} total bytes`
            );
            logger.debug(
              "archiver has been finalized and the output file descriptor has closed."
            );

            // delete all images
            for (var i = 0; i < files.length; i++) {
              var file = `/tmp/${files[i]}`;
              utils.deleteFile(file);
            }

            //return compressed file
            return utils.downloadFile(
              compressFilePath,
              compressFileName,
              req,
              res,
              next
            );
          });
          // Wait for streams to complete
          archive.finalize();
        } else {
          //return JSON list of extracted images

          logger.debug(`output files in /tmp`);
          var responseJson = {};
          let externalPort = constants.externalPort || constants.serverPort;
          responseJson["totalfiles"] = files.length;
          responseJson[
            "description"
          ] = `Extracted image files and URLs to download them. By default, downloading image also deletes the image from server. Note that port ${externalPort} in the URL may not be the same as the real port, especially if server is running on Docker/Kubernetes.`;
          var filesArray = [];
          for (var i = 0; i < files.length; i++) {
            var file = files[i];
            logger.debug("file: " + file);
            var fileJson = {};
            fileJson["name"] = file;
            fileJson[
              `url`
            ] = `${req.protocol}://${req.hostname}:${externalPort}${req.baseUrl}/download/${file}`;
            filesArray.push(fileJson);
          }
          responseJson["files"] = filesArray;
          res.status(200).send(responseJson);
        }
      })
      .run();
  }
}

module.exports = router;
