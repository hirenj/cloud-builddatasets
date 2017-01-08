"use strict";

const AWS = require('aws-sdk');

let promisify = function(aws) {
  aws.Request.prototype.promise = function() {
    return new Promise(function(accept, reject) {
      this.on('complete', function(response) {
        if (response.error) {
          reject(response.error);
        } else {
          accept(response.data);
        }
      });
      this.send();
    }.bind(this));
  };
};

promisify(AWS);

const codebuild = new AWS.CodeBuild();

let list_projects = function() {
    return codebuild.listProjects().promise().then((projects) => {
      return projects.projects;  
    });
};

// No easy way to get running builds?
let running_builds_for_project = function(project) {
    return Promise.resolve([]);
};

let start_build = function(project) {
    return codebuild.startBuild({ projectName: project}).promise();
};

exports.handler = (event, context, callback) => {
    list_projects().then( (projects) => {
        console.log("Starting build for ",projects.join(','));
        Promise.all(projects.map(start_build))
    }).then( () => {
        callback(null,'OK');
    }).catch( (err) => {
        callback(err);
    });
};