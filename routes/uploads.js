'use strict';

// External dependencies
const express = require('express');
const multer = require('multer');
const path = require('path');
const checkCSRF = require('csurf')();
const fileType = require('file-type');
const readChunk = require('read-chunk');
const fs = require('fs');
const isSVG = require('is-svg');
const config = require('config');
const is = require('type-is');
const { promisify } = require('util');

// Internal dependencies
const File = require('../models/file');
const getResourceErrorHandler = require('./handlers/resource-error-handler');
const render = require('./helpers/render');
const slugs = require('./helpers/slugs');
const debug = require('../util/debug');
const ReportedError = require('../util/reported-error');
const languages = require('../locales/languages');
const forms = require('./helpers/forms');

const readFile = promisify(fs.readFile),
  rename = promisify(fs.rename),
  unlink = promisify(fs.unlink);
const stage1Router = express.Router(),
  stage2Router = express.Router();

const allowedTypes = [
  'image/png', 'image/gif', 'image/svg+xml', 'image/jpeg', 'image/webp',
  'video/webm', 'video/ogg',
  'audio/ogg', 'audio/mpeg'
];

// You can upload multiple uploads in one batch; this form is used to process
// the metadata
const uploadFormDef = [{
    name: 'upload-language',
    required: true
  }, {
    name: 'upload-%uuid',
    required: false,
    keyValueMap: 'uploads'
  }, {
    name: 'upload-%uuid-description',
    required: false,
    type: 'text',
    keyValueMap: 'descriptions'
  }, {
    name: 'upload-%uuid-by',
    required: false,
    type: 'string', // can be 'uploader' or 'other'
    keyValueMap: 'creators'
  }, {
    required: false,
    name: 'upload-%uuid-creator',
    type: 'text',
    keyValueMap: 'creatorDetails'
  },
  {
    name: 'upload-%uuid-source',
    required: false,
    type: 'text',
    keyValueMap: 'sources'
  },
  {
    name: 'upload-license-%uuid',
    required: false,
    type: 'string', // enum defined in model
    keyValueMap: 'licenses'
  }
];

// Uploading is a two step process. In the first step, the user simply posts the
// file or files. In the second step, they provide information such as the
// license and description. This first step has to be handled prior to the CSRF
// middleware because of the requirement of managing upload streams and
// multipart forms.
//
// Whether or not an upload is finished, as long as we have a valid file, we
// keep it on disk, initially in a temporary directory. We also create a
// record in the "files" table for it that can be completed later.
stage1Router.post('/:id/upload', function(req, res, next) {

  // On to stage 2
  if (!is(req, ['multipart']))
    return next();

  let id = req.params.id.trim();
  slugs.resolveAndLoadThing(req, res, id)
    .then(thing => {

      thing.populateUserInfo(req.user);
      if (!thing.userCanUpload)
        return render.permissionError(req, res, {
          titleKey: 'add media'
        });

      let storage = multer.diskStorage({
        destination: config.uploadTempDir,
        filename(req, file, done) {
          let p = path.parse(file.originalname);
          let name = `${p.name}-${Date.now()}${p.ext}`;
          name.replace(/<>&/g, '');
          done(null, name);
        }
      });

      let upload = multer({
        limits: {
          fileSize: config.uploadMagSize
        },
        fileFilter: getFileFilter(req, res),
        storage
      }).array('media');

      // Execute the actual upload middleware
      upload(req, res, getUploadHandler(req, res, next, thing));
    })
    .catch(getResourceErrorHandler(req, res, next, 'thing', id));
});


// We need to handle CSRF issues manually at this stage.
//
// Note that at the time the filter runs, we won't have the complete file yet,
// so we may temporarily store files and delete them later if, after
// investigation, they turn out to contain unacceptable content.
function getFileFilter(req, res) {
  return (req, file, done) => {
    checkCSRF(req, res, error => {
      if (error)
        return done(error); // Bad CSRF token, reject upload

      if (allowedTypes.indexOf(file.mimetype) == -1) {
        done(new ReportedError({
          userMessage: 'unsupported file type',
          userMessageParams: [file.originalname, file.mimetype]
        }));
      } else
        done(null, true); // Accept file for further investigation
    });
  };
}

// Checks validity of the files and, if appropriate, performs the actual upload
function getUploadHandler(req, res, next, thing) {
  return error => {

    const abortUpload = uploadError => {
      cleanupFiles(req); // Async, but we don't wait for completion
      req.flashError(uploadError);
      res.redirect(`/${thing.urlID}`);
    };

    // An error at this stage most likely means an unsupported file type was among the batch.
    // We reject the whole batch and report the bad apple.
    if (error)
      return abortUpload(error);

    if (req.files.length) {
      validateFiles(req.files)
        .then(fileTypes => attachFilesToThing(req, res, thing, fileTypes))
        .then(uploadedFiles =>
          render.template(req, res, 'thing-upload-step-2', {
            titleKey: 'add media',
            thing,
            uploadedFiles
          })
        )
        .catch(abortUpload);
    } else {
      req.flash('pageErrors', req.__('no file received'));
      res.redirect(`/${thing.urlID}`);
    }
  };
}

async function validateFiles(files) {
  let validators = [];
  files.forEach(file => {
    // SVG files need full examination
    if (file.mimetype != 'image/svg+xml')
      validators.push(validateFile(file.path, file.mimetype));
    else
      validators.push(validateSVG(file.path));
  });
  const fileTypes = await Promise.all(validators);
  return fileTypes;
}

async function attachFilesToThing(req, res, thing, fileTypes) {
  let fileRevPromises = [];
  req.files.forEach(() => fileRevPromises.push(File.createFirstRevision(req.user)));
  const fileRevs = await Promise.all(fileRevPromises);
  let newFiles = [];
  req.files.forEach((file, index) => {
    fileRevs[index].name = file.filename;
    // We don't use the reported MIME type from the upload
    // because it may be wrong in some edge cases like Ogg
    // audio vs. Ogg video
    fileRevs[index].mimeType = fileTypes[index];
    fileRevs[index].uploadedBy = req.user.id;
    fileRevs[index].uploadedOn = new Date();
    thing.addFile(fileRevs[index]);
    newFiles.push(fileRevs[index]);
  });
  await thing.saveAll(); // saves joined files
  return newFiles;
}

async function cleanupFiles(req) {
  if (!Array.isArray(req.files))
    return;

  try {
    await Promise.all(req.files.map(unlink));
  } catch (error) {
    debug.error({ error, req });
  }
}

// Verify that a file's contents match its claimed MIME type. This is shallow,
// fast validation. If files are manipulated, we need to pay further attention
// to any possible exploits.
async function validateFile(filePath, claimedType) {
  const buffer = await readChunk(filePath, 0, 262);
  const type = fileType(buffer);

  // Browser sometimes misreports media type for Ogg files. We don't throw an
  // error in this case, but return the correct type.
  const allOgg = (...types) => types.every(type => /\/ogg$/.test(type));

  if (!type)
    throw new ReportedError({
      userMessage: 'unrecognized file type',
      userMessageParams: [path.basename(filePath)],
    });
  else if (type.mime !== claimedType && !allOgg(type.mime, claimedType))
    throw new ReportedError({
      userMessage: 'mime mismatch',
      userMessageParams: [path.basename(filePath), claimedType, type.mime],
    });
  else
    return type.mime;
}

// SVGs can't be validated by magic number check. This, too, is a relatively
// shallow validation, not a full XML parse.
async function validateSVG(filePath) {
  const data = await readFile(filePath);
  if (isSVG(data))
    return 'image/svg+xml';
  else
    throw new ReportedError({
      userMessage: 'not valid svg',
      userMessageParams: [path.basename(filePath)],
    });
}

// If an upload is unfinished, it can still be viewed at its destination URL
// by the user who uploaded it.
stage1Router.get('/static/uploads/:name', function(req, res, next) {
  if (!req.user)
    return next();

  File
    .getStashedUpload(req.user.id, req.params.name)
    .then(upload => {
      if (!upload)
        return next();
      res.sendFile(path.join(config.uploadTempDir, upload.name));
    })
    .catch(next);
});

// This route handles step 2 of a file upload, the addition of metadata.
// Step 1 is handled as an earlier middleware in process-uploads.js, due to the
// requirement of handling file streams and a multipart form.
stage2Router.post('/:id/upload', function(req, res, next) {
  let id = req.params.id.trim();
  slugs.resolveAndLoadThing(req, res, id)
    .then(thing => {

      thing.populateUserInfo(req.user);
      if (!thing.userCanUpload)
        return render.permissionError(req, res, {
          titleKey: 'add media'
        });

      let language = req.body['upload-language'];
      if (!languages.isValid(language)) {
        req.flash('pageErrors', req.__('invalid language code', language));
        return res.redirect(`/${thing.urlID}`);
      }

      let formData = forms.parseSubmission(req, {
        formDef: uploadFormDef,
        formKey: 'upload-file',
        language
      });

      if (req.flashHas('pageErrors'))
        return res.redirect(`/${thing.urlID}`);

      if (!formData.formValues.uploads || !Object.keys(formData.formValues.uploads).length) {
        // No valid uploads
        req.flash('pageErrors', req.__('data missing'));
        return res.redirect(`/${thing.urlID}`);
      }

      let uploadPromises = [];
      for (let uploadID in formData.formValues.uploads) {
        uploadPromises.push(File.getNotStaleOrDeleted(uploadID));
      }

      // The execution sequence here is:
      // 1) Parse the form and abort if there's a problem with any given upload.
      // 2) If there's no problem, move the upload to its final location,
      //    update its metadata and mark it as finished.
      Promise
        .all(uploadPromises)
        .then(uploads => {
          let finishUploadPromises = [];

          uploads.forEach(upload => {

            let getVal = obj => !Array.isArray(obj) || !obj[upload.id] ? null : obj[upload.id];

            upload.description = getVal(formData.formValues.descriptions);

            if (!upload.description || !upload.description[language])
              throw new ReportedError({
                message: `Form data for upload %s lacks a description.`,
                messageParams: [upload.name],
                userMessage: 'upload needs description',
              });

            let by = getVal(formData.formValues.creators);
            if (!by)
              throw new ReportedError({
                message: `Form data for upload missing creator information.`,
                userMessage: 'data missing'
              });

            if (by === 'other') {
              upload.creator = getVal(formData.formValues.creatorDetails);

              if (!upload.creator || !upload.creator[language])
                throw new ReportedError({
                  message: 'Form data for upload %s lacks creator information.',
                  messageParams: [upload.name],
                  userMessage: 'upload needs creator'
                });

              upload.source = getVal(formData.formValues.sources);

              if (!upload.source || !upload.source[language])
                throw new ReportedError({
                  message: 'Form data for upload %s lacks source information.',
                  messageParams: [upload.name],
                  userMessage: 'upload needs source'
                });

              upload.license = getVal(formData.formValues.licenses);

              if (!upload.license)
                throw new ReportedError({
                  message: 'Form data for upload %s lacks license information.',
                  messageParams: [upload.name],
                  userMessage: 'upload needs license'
                });

            } else if (by === 'uploader') {
              upload.license = 'cc-by-sa';
            } else {
              throw new ReportedError({
                message: 'Upload form contained unexpected form data.',
                userMessage: 'unexpected form data'
              });
            }
            upload.completed = true;
            finishUploadPromises.push(finishUpload(upload));
          });

          Promise
            .all(finishUploadPromises)
            .then(() => {
              req.flash('pageMessages', req.__('upload completed'));
              res.redirect(`/${thing.urlID}`);
            })
            .catch(next);
        })
        .catch(error => {
          req.flashError(error);
          return res.redirect(`/${thing.urlID}`);
        });
    })
    .catch(getResourceErrorHandler(req, res, next, 'thing', id));
});

async function finishUpload(upload) {
  // File names are sanitized on input but ..
  // This error is not shown to the user but logged, hence native.
  if (!upload.name || /[/<>]/.test(upload.name))
    throw new Error(`Invalid filename: ${upload.name}`);

  // Move the file to its final location so it can be served
  let oldPath = path.join(config.uploadTempDir, upload.name),
    newPath = path.join(__dirname, '../static/uploads', upload.name);

  await rename(oldPath, newPath);
  try {
    await upload.save();
  } catch (error) {
    // Problem saving the metadata. Move upload back to
    // temporary stash.
    await rename(newPath, oldPath);
  }
}

module.exports = {
  stage1Router,
  stage2Router
};