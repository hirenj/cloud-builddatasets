/**
 */
'use strict';

require('es6-promise').polyfill();
var AWS = require('aws-sdk');
var is_new_template = false;

AWS.Request.prototype.promise = function() {
	return new Promise(function(accept, reject) {
	this.on('complete', function(response) {
		if (response.error) {
		reject(response.error);
		} else {
		accept(response);
		}
	});
	this.send();
	}.bind(this));
};

var cloudformation;
var s3;

var new_resources_func = function(stack,resources) {
	if (resources.data.NextToken) {
		return cloudformation.listStackResources({'StackName' : stack, 'NextToken' : resources.data.NextToken }).promise()
		.then(new_resources_func.bind(null,stack))
		.then(function(nextpage) {
			return resources.data.StackResourceSummaries.concat(nextpage);
		});
	} else {
		return resources.data.StackResourceSummaries;
	}
};

var read_stack_resources = function(stack) {
	return cloudformation.listStackResources({ 'StackName' : stack }).promise()
	.then(new_resources_func.bind(null,stack))
	.catch(function(err) {
		console.log(err);
		console.log(err.stack);
		return Promise.resolve(true);
	});
};

var read_stack_region = function(stack) {
	return cloudformation.describeStacks({'StackName' : stack}).promise()
	.then(function(stack_info) {
		return stack_info.data.Stacks[0].StackId.split(':')[3];
	});
};

var make_lookup = function(resources) {
	var result = {};
	resources.forEach(function(resource) {
		result[resource.LogicalResourceId] = resource.PhysicalResourceId;
	});
	return result;
};

var summarise_resources = function(stack,resources) {
	var lambdas = resources.filter(function(resource) {
		return resource.ResourceType == 'AWS::Lambda::Function';
	});
	var dynamodbs = resources.filter(function(resource) {
		return resource.ResourceType == 'AWS::DynamoDB::Table';
	});
	var buckets = resources.filter(function(resource) {
		return resource.ResourceType == 'AWS::S3::Bucket';
	});
	var queue = resources.filter(function(resource) {
		return resource.ResourceType == 'AWS::SQS::Queue' ||
				resource.ResourceType == 'AWS::SNS::Topic'
	});
	var key = resources.filter(function(resource) {
		return resource.ResourceType == 'AWS::KMS::Key';
	});
	var stack_conf = { 	'stack' : stack,
						'functions' : make_lookup(lambdas),
						'keys' : make_lookup(key),
						'tables' : make_lookup(dynamodbs),
						'buckets' : make_lookup(buckets),
						'queue' : make_lookup(queue) };
	return stack_conf;
}

var apply_submodule_config = function(common_template) {
	var git_config = require('git-config').sync('.gitmodules');
	var rolenames = [];
	var buildspec = require('fs').readFileSync('buildspec.yml').toString();
	var buildnames = [];
	Object.keys(git_config).forEach(module => {
		var conf = git_config[module];
		var original_path = conf.path.replace(/builds\//,'');
		var compute_size = (original_path.match(/@(.*)$/) || [null,'SMALL'])[1].toUpperCase();
		var modulename = original_path.replace(/@.*$/,'').replace(/[^0-9a-z\.\_]/,'');
		rolenames.push(modulename+'Role');
		var buildname = modulename+'BuildProject';
		buildnames.push(buildname);
		common_template.Resources[buildname] = JSON.parse(JSON.stringify(common_template.Resources.templateBuildProject));
		var is_node = require('fs').existsSync(conf.path+'/package.json');
		common_template.Resources[buildname].Properties.ServiceRole = { "Ref" : modulename+"Role" };
		common_template.Resources[buildname].Properties.Source.Location = conf.url.replace(/\.git$/,'')+'.git';
		common_template.Resources[buildname].Properties.Source.BuildSpec = buildspec;
		common_template.Resources[buildname].Properties.Environment.EnvironmentVariables[1].Value = modulename;
		common_template.Resources[buildname].Properties.Environment.ComputeType = 'BUILD_GENERAL1_'+compute_size;
		common_template.Resources[buildname].Properties.Name = modulename;
	});
	common_template.Resources['RunBuildsPolicy'].Properties.PolicyDocument.Statement[0].Resource = buildnames.map( (name) => { return  { "Fn::GetAtt" : [ name, "Arn" ]}; });
	common_template.Resources.DatabuilderLogWriterPolicy.Properties.Roles = rolenames.map( (name)=> { return { 'Ref' : name } });
	rolenames.forEach( name => {
		common_template.Resources[name] = JSON.parse(JSON.stringify(common_template.Resources.templateRole));
		common_template.Resources[name].Properties.Policies[0].PolicyDocument.Statement[0].Resource.forEach( res  => {
			res['Fn::Join'][1][3] = name.replace(/Role$/,'');
		});
	});

	var runBuildsCode = require('fs').readFileSync('RunBuilds.js').toString();
	common_template.Resources.RunBuilds.Properties.Code.ZipFile = runBuildsCode;

	delete common_template.Resources.templateRole;
	delete common_template.Resources.templateBuildProject;
	return common_template;
};

module.exports = function(grunt) {
	require('load-grunt-tasks')(grunt);

	AWS.config.update({region:'us-east-1'});


	if (grunt.option('region')) {
		AWS.config.update({region:grunt.option('region')});
	}

	cloudformation = new AWS.CloudFormation();
	s3 = new AWS.S3();

	var path = require('path');
	grunt.initConfig({
		grunt: {
		}
	});

	grunt.registerTask('get_resources', 'Get CloudFormation resources', function(stack) {
		var done = this.async();
		stack = stack || 'test';
		read_stack_resources(stack).then(function(resources) {
			return read_stack_region(stack).then(function(region) {
				var summary = summarise_resources(stack,resources);
				summary.region = region;
				grunt.file.write(stack+'-resources.conf.json',JSON.stringify(summary,null,'  '));
				done();
			});
		});
	});

	grunt.registerTask('get_current_template','Get cloudformation template',function(stack) {
		var done = this.async();
		cloudformation.getTemplate({'StackName' : stack}).promise().then((response) => {
			grunt.file.write(stack+'_last.template',JSON.stringify(JSON.parse(response.data.TemplateBody),null,'  '));
			done();
		});
	});

	grunt.registerTask('compare_templates','Compare two CloudFormation templates',function(stack) {
		grunt.task.run('get_current_template:'+stack);
		grunt.task.run('diff_template:'+stack);
	});

	grunt.registerTask('update_cloudformation','Update a stack if necessary',function() {
		var stack = grunt.option('stack');
		var done = this.async();
		if (is_new_template) {
			var key = (new Date()).getTime()+'builddatasets.template';
			s3.putObject({ Bucket: grunt.option('cf-bucket'), Key: key, Body: grunt.file.read('builddatasets.template') }).promise().then(() => {
				console.log("Created template on S3, initiating changeset");
				return cloudformation.createChangeSet({ChangeSetName: stack+'-patch', Capabilities: ['CAPABILITY_NAMED_IAM'], StackName: stack, TemplateURL: 'https://s3.amazonaws.com/'+grunt.option('cf-bucket')+'/'+key }).promise().then((response) => {
					console.log(response.data);
				});
			}).catch((err) => console.log(err)).then(() => done() );;
		} else {
			done();
		}
	});

	grunt.registerTask('deploy_stack','',function(stack) {
		grunt.option('stack',stack);
		grunt.task.run('build_cloudformation');
		grunt.task.run('get_current_template:'+stack);
		grunt.task.run('compare_templates:'+stack);
		grunt.task.run('update_cloudformation');
	});

	grunt.registerTask('diff_template','Diff two CloudFormation templates',function(stack) {
		let diff = require('rus-diff').rusDiff(grunt.file.readJSON(stack+'_last.template'),grunt.file.readJSON('builddatasets.template'));
		if (Object.keys(diff).length !== 0) {
			is_new_template = true;
			console.log(diff);
		}
	});

	grunt.registerTask('build_cloudformation', 'Build cloudformation template',function() {
		var template_paths = [];
		template_paths = template_paths.concat(grunt.file.expand('resources/*.template'));
		var templates = template_paths.map(function(template) {
			return grunt.file.readJSON(template);
		});
		var common_template = templates.reduce(function(prev,curr) {
			if (! prev) {
				return curr;
			}
			if ( ! prev.Resources ) {
				prev.Resources = {};
			}
			Object.keys(curr.Resources).forEach(function(key) {
				prev.Resources[key] = curr.Resources[key];
			});
			if ( ! prev.Outputs ) {
				prev.Outputs = {};
			}
			Object.keys(curr.Outputs || {}).forEach(function(key) {
				prev.Outputs[key] = curr.Outputs[key];
			});
			return prev;
		});
		apply_submodule_config(common_template);
		grunt.file.write('builddatasets.template',JSON.stringify(common_template,null,'  '));
	});
};
