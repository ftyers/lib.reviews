'use strict';
const config = require('config');

let forms = {

  parseSubmission: function(options) {
    let req = options.req;
    // Do not manipulate original form definition
    let formDef = Object.assign([], options.formDef);
    let formKey = options.formKey;

    let hasRequiredFields = true;
    let hasUnknownFields = false;
    let hasCorrectCaptcha = null;
    let formValues = {};
    let processedKeys = Object.keys(req.body);

    // Any form submission requires a CSRF token
    formDef.push({
      name: '_csrf',
      required: true
    });

    // Process simple captcha if enabled for this form
    if (config.questionCaptcha.forms[formKey]) {
      formDef.push({
        name: 'captcha-id',
        required: true
      }, {
        name: 'captcha-answer',
        required: true
      });

      hasCorrectCaptcha = this.processCaptchaAnswer(req);
    }

    for (let field of formDef) {
      if (!req.body[field.name] && field.required) {
        req.flash('pageErrors', req.__(`need ${field.name}`));
        hasRequiredFields = false;
      }
      if (req.body[field.name] && !field.radioMap)
        formValues[field.name] = req.body[field.name];
      if (req.body[field.name] && field.radioMap) {
        formValues[field.name] = {};
        formValues[field.name].value = req.body[field.name];
        formValues[field.name][req.body[field.name]] = true;
      }
      let k = processedKeys.indexOf(field.name);
      if (k !== -1)
        processedKeys.splice(k, 1);
    }
    if (processedKeys.length) {
      hasUnknownFields = true;
      req.flash('pageErrors', req.__('unexpected form data'));
    }
    return {
      hasRequiredFields,
      hasUnknownFields,
      hasCorrectCaptcha,
      formValues
    };
  },

  getQuestionCaptcha: function(formKey) {
    let id;
    if (config.questionCaptcha.forms[formKey]) {
      id = Math.floor(Math.random() * config.questionCaptcha.captchas.length);
      return {
        id,
        captcha: config.questionCaptcha.captchas[id]
      };
    } else
      return undefined;
  },

  processCaptchaAnswer: function(req) {

    let id = req.body['captcha-id'];
    let answerText = req.body['captcha-answer'];

    if (!answerText) //  no need to flash - missing field error message will kick in
      return false;

    if (!config.questionCaptcha.captchas[id]) {
      req.flash('pageErrors', req.__('unknown captcha'));
      return false;
    }

    if (answerText.trim().toUpperCase() !== req.__(config.questionCaptcha.captchas[id].answerKey).toUpperCase()) {
      req.flash('pageErrors', req.__('incorrect captcha answer'));
      return false;
    } else
      return true;
  }

};

module.exports = forms;