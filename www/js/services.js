angular.module('ptApp.services', ['ptConfig'])

.factory('Main', function($rootScope, $http, PT_CONFIG){
  localStorage['user'] = localStorage['user'] || '{}';

  var service = {
    user: JSON.parse(localStorage['user']),

    interceptResponse: function(data, status){
      if(status == 404){
        $rootScope.$broadcast('connectionError');
      }
    },

    setInstallationId: function(aggregatorUrl){
      $http.get(aggregatorUrl + 'getId')
      .success(function(response){
        localStorage['installationId'] = response['payload']['installation_id'];
      });
    },

    updateUserInfo: function(){
      localStorage['user'] = JSON.stringify(this.user);
    }
  }

  if(!localStorage['installationId']){
    service.setInstallationId(PT_CONFIG.aggregatorUrl);
  }

  return service;
})

.factory('Survey', function($rootScope, $http, $ionicPopup, $state, $filter, $location, PT_CONFIG, Main){
  localStorage['surveys'] = localStorage['surveys'] || '{}';
  localStorage['unsynced'] = localStorage['unsynced'] || '[]';
  localStorage['unsyncedImages'] = localStorage['unsyncedImages'] || '[]';
  localStorage['synced'] = localStorage['synced'] || '[]';

  var service = {
    surveys: JSON.parse(localStorage['surveys']),
    unsynced: JSON.parse(localStorage['unsynced']),
    synced: JSON.parse(localStorage['synced']),
    unsyncedImages: JSON.parse(localStorage['unsyncedImages']),
    currentResponse: {},
    currentSyncItemTotal: 0,
    currentSyncPercentage: 0,
    syncing: false,

    isSyncing: function(){
      return this.syncing;
    },

    hasUnsyncedItems: function(){
      return this.unsynced.length + this.unsyncedImages.length > 0;
    },

    getCampaignId: function(surveyId){
      var survey = this.surveys[surveyId];
      return survey.campaign_id;
    },

    fetchSurvey: function(surveyCode, successCallback, errorCallback){
      var self = this;
      $http.get(PT_CONFIG.aggregatorUrl + 'surveys/' + surveyCode)
        .success(function(data){
          if(data.status == 'success'){
            successCallback(data);
          } else {
            errorCallback(data.error_code.toString());
          }
        })

        .error(function(data, status){
          Main.interceptResponse(data, status);
        });
    },

    queueNewResponse: function(surveyId, locationDisabled){
      var self = this;
      self.currentResponse = {
        installation_id: localStorage['installationId'],
        survey_id: surveyId,
        status: self.surveys[surveyId].status,
        timestamp: Date.now(),
        locationstamp: {},
        inputs: JSON.parse(JSON.stringify(self.surveys[surveyId].inputs)),
        activeIndex: 0
      };

      if(!locationDisabled){
        navigator.geolocation.getCurrentPosition(function(position){
          self.currentResponse.locationstamp.lon = position.coords.longitude;
          self.currentResponse.locationstamp.lat = position.coords.latitude;
        });
      }
      console.log(self.currentResponse);
    },

    addResponseToUnsynced: function(response){
      var index = this.unsynced.indexOf(response);
      if(index == -1){
        this.unsynced.push(response);
        localStorage['unsynced'] = JSON.stringify(this.unsynced);
      }
    },

    removeResponseFromUnsynced: function(response){
      var index = this.unsynced.indexOf(response);
      if(index > -1){
        this.unsynced.splice(index, 1);
        localStorage['unsynced'] = JSON.stringify(this.unsynced);
      }
    },

    refreshSyncItemCount: function(){
      this.currentSyncItemTotal = this.unsyncedImages.length + this.unsynced.length;
    },

    getSyncMessage: function(){
      var itemsToGo = this.unsyncedImages.length + this.unsynced.length;
      var message = (this.currentSyncItemTotal-itemsToGo+1) + '/' + this.currentSyncItemTotal;
      if(this.currentSyncPercentage > 0 && this.currentSyncPercentage < 100){
        message += " " + this.currentSyncPercentage + "%";
      }
      return message;
    },

    addImageToUnsynced: function(response){
      var self = this;
      // Search for images in the survey response
      response.inputs.forEach(function(input){
        if(input.input_type == 'image' && input.answer){
          self.unsyncedImages.push({id: response.id, input_id: input.id, fileLocation: input.answer});
        }
      });
      self.syncImages();
    },

    removeImageFromUnsynced: function(image){
      var self = this;
      var index = this.unsyncedImages.indexOf(image);
      if(index > -1){
        this.unsyncedImages.splice(index, 1);
        localStorage['unsyncedImages'] = JSON.stringify(this.unsyncedImages);
      }
    },

    addResponseToSynced: function(response){
      var index = this.unsynced.indexOf(response);
      this.synced.push(response);
      localStorage['synced'] = JSON.stringify(this.synced)
      if(index > -1){
        this.unsynced.splice(index, 1);
        localStorage['unsynced'] = JSON.stringify(this.unsynced);
      }
    },

    formatResponse: function(response){
      var formattedResponse = {
        installation_id: localStorage.installationId,
        survey_id: response.survey_id,
        status: response.status,
        timestamp: response.timestamp,
        locationstamp: response.locationstamp,
        answers: []
      };

      response.inputs.forEach(function(input){
        var answer = { id: input.id, value: input.answer, input_type: input.input_type };

        if(input.input_type == 'select'){
          answer.value = input.answer.map(function(value, index){
            if(value){
              return input.options[index];
            }
          }).filter(function(n){ return n!= undefined; });
        }

        formattedResponse.answers.push(answer);
      })

      return formattedResponse;
    },

    syncResponse: function(response){
      var self = this;
      var formattedResponse = self.formatResponse(response);
      self.syncing =  true;
      $rootScope.$broadcast('updateStatus');
      $http.post(
        PT_CONFIG.aggregatorUrl + 'responses', 
        { response: JSON.stringify(formattedResponse) }
      )
        .success(function(data){
          if(data['status'] == 'success'){
            response.id = data.payload.id;
            self.removeResponseFromUnsynced(response);
            self.addResponseToSynced(formattedResponse);
            self.addImageToUnsynced(response);
          } else {
            self.addResponseToUnsynced(response);
          }
          if(self.unsynced.length + self.unsyncedImages.length == 0) {
            self.syncing = false;
            $rootScope.$broadcast('updateStatus');
            $rootScope.$broadcast('viewMap', response.survey_id);
          }
          self.refreshSyncItemCount();
          self.syncResponses();
        })

        .error(function(data, status){
          Main.interceptResponse(data, status);
          self.syncing = false;
          $rootScope.$broadcast('updateStatus');
        });
    },

    syncImage: function(image){
      var self = this;
      self.syncing = true;
      $rootScope.$broadcast('updateStatus');
      // TODO: need to find if the image really exists
      // upload the image with cordova file-transfer
      var options = new FileUploadOptions();
      options.fileKey = "file";
      options.fileName = image.fileLocation.substr(image.fileLocation.lastIndexOf('/') + 1);
      options.mimeType = "image/jpeg";
      options.params = image;
      options.headers = { 'Authorization': PT_CONFIG.accessKey };
      var fileTransfer = new FileTransfer();
      fileTransfer.onprogress = function(result){
           var percent =  result.loaded / result.total * 100;
           percent = Math.round(percent);
           self.currentSyncPercentage = percent;
           $rootScope.$broadcast('updateStatus');
      };
      fileTransfer.upload(image.fileLocation, encodeURI(PT_CONFIG.aggregatorUrl + 'upload_image'),

        function(){   // upload succeed
          self.removeImageFromUnsynced(image);
          self.syncing = false;
          $rootScope.$broadcast('updateStatus');
          self.syncImages();
          self.currentSyncPercentage = 0;
        }, 

        function(error){   // upload failed
          // TODO: notify user of image upload failure
          Main.interceptResponse(data, status);
          self.currentSyncPercentage = 0;
          self.syncing =false;
          $rootScope.$broadcast('updateStatus');
        }, options);
    },

    syncResponses: function(){
      var self = this;
      if(self.unsynced.length>0){
        self.syncResponse(self.unsynced[0]);
      }
    },

    syncImages: function(){
      var self = this;
      if(self.unsyncedImages.length>0){
        self.syncImage(self.unsyncedImages[0]);
      }
    },

    cancelResponse: function() {
      var confirmPopup = $ionicPopup.confirm({
        template: $filter('translate')('DELETE_RESPONSE'),
        buttons: [
          {
            text: $filter('translate')('CANCEL')
          },
          {
            text: $filter('translate')('DELETE'),
            type: 'button-pink',
            onTap: function(){ return true; }
          }
        ]
      });
      confirmPopup.then(function(res) {
        if(res) {
          self.currentResponse = {};
          $state.go('home');
        }
      });
    }
  };

  return service;
})
