// Copyright (C) 2010-2014 GRNET S.A.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.
// 

;(function(root){
    // Neutron api models, collections, helpers
  
    // root
    var root = root;
    
    // setup namepsaces
    var snf = root.synnefo = root.synnefo || {};
    var snfmodels = snf.models = snf.models || {}
    var models = snfmodels.networks = snfmodels.networks || {};
    var storage = snf.storage = snf.storage || {};
    var util = snf.util = snf.util || {};

    // shortcuts
    var bb = root.Backbone;
    var slice = Array.prototype.slice

    // logging
    var logger = new snf.logging.logger("SNF-MODELS");
    var debug = _.bind(logger.debug, logger);
    
    // Neutron base model, extending existing synnefo model
    models.NetworkModel = snfmodels.Model.extend({
      api_type: 'network',
      toJSON: function() {
        var res = {};
        _.each(this.attributes, function(attr, key) {
          if (attr instanceof bb.Collection) {
            attr = "[Collection object]";
          }
          res[key] = attr;
        });
        return res;
      }
    });
    
    // Neutron base collection, common neutron collection params are shared
    models.NetworkCollection = snfmodels.Collection.extend({
      api_type: 'network',
      details: true,
      noUpdate: true,
      updateEntries: true,
      add_on_create: true
    });
  
    // Subnet model
    models.Subnet = models.NetworkModel.extend();
    
    // Subnet collection
    models.Subnets = models.NetworkCollection.extend({
      model: models.Subnet,
      details: false,
      path: 'subnets',
      parse: function(resp) {
        return resp.subnets
      }
    });
    
    // Network 
    models.Network = models.NetworkModel.extend({
      path: 'networks',
      
      url: function(options, method) {
        var url = models.Network.__super__.url.call(this, method, options);
        if (options.data && options.data.reassign) {
          return url + '/action';
        }
        return url;
      },

      parse: function(obj) {
        return obj.network;
      },

      // Available network actions.
      // connect: 
      model_actions: {
        'connect': [['status', 'is_public'], function() {
          //TODO: Also check network status
          return !this.is_public() && _.contains(['ACTIVE'], this.get('status'));
        }],
        'remove': [['status', 'is_public', 'ports'], function() {
          if (this.ports && this.ports.length) {
            return false
          }
          return !this.is_public() && _.contains(['ACTIVE'], this.get('status'));
        }]
      },
      
      do_remove: function(succ, err) {
        this.actions.reset_pending();
        this.destroy({
          success: _.bind(function() {
            synnefo.api.trigger("quotas:call", 10);
            this.set({status: 'REMOVING'});
            this.set({ext_status: 'REMOVING'});
            // force status display update
            this.set({cidr: 'REMOVING'});
          }, this),
          silent: true
        });
      },

      proxy_attrs: {
        'is_public': [
          ['router:external', 'public'], function() {
            return this.get('router:external') || this.get('public')
          } 
        ],
        'is_floating': [
          ['SNF:floating_ip_pool'], function() {
            return this.get('SNF:floating_ip_pool')
          }
        ],
        'cidr': [
          ['subnet'], function() {
            var subnet = this.get('subnet');
            if (subnet && subnet.get('cidr')) {
              return subnet.get('cidr')
            } else {
              return undefined
            }
          }
        ],
        'ext_status': [
          ['status', 'cidr'], function(st) {
            if (this.get('ext_status') == 'REMOVING') {
              return 'REMOVING'
            }
            if (this.pending_connections) {
              return 'CONNECTING'
            } else if (this.pending_disconnects) {
              return 'DISCONNECTING'
            } else {
              return this.get('status')
            }
        }],
        'in_progress': [
          ['ext_status'], function() {
            return _.contains(['CONNECTING', 
                               'DISCONNECTING', 
                               'REMOVING'], 
                               this.get('ext_status'))
          }  
        ]
      },
      
      storage_attrs: {
        'subnets': ['subnets', 'subnet', function(model, attr) {
          var subnets = model.get(attr);
          if (subnets && subnets.length) { return subnets[0] }
        }],
        'tenant_id': ['projects', 'project']
      },

      // call rename api
      rename: function(new_name, cb) {
          var self = this;
          this.sync("update", this, {
              critical: true,
              data: {
                  'network': {
                      'name': new_name
                  }
              }, 
              // do the rename after the method succeeds
              success: _.bind(function(){
                  //this.set({name: new_name});
                  snf.api.trigger("call");
                  self.set({name: new_name});
              }, this),
              complete: cb || function() {}
          });
      },

      pending_connections: 0,
      pending_disconnects: 0,

      initialize: function() {
        var self = this;
        this.subnets = new Backbone.FilteredCollection(undefined, {
          collection: synnefo.storage.subnets,
          collectionFilter: function(m) {
            return self.id == m.get('network_id')
        }});
        this.ports = new Backbone.FilteredCollection(undefined, {
          collection: synnefo.storage.ports,
          collectionFilter: function(m) {
            return self.id == m.get('network_id')
          }
        });
        this.ports.network = this;
        this.ports.bind("reset", function() {
          this.pending_connections = 0;
          this.pending_disconnects = 0;
          this.update_connecting_status();
          this.update_actions();
        }, this);
        this.ports.bind("add", function() {
          this.pending_connections--;
          this.update_connecting_status();
          this.update_actions();
        }, this);
        this.ports.bind("remove", function() {
          this.pending_disconnects--;
          this.update_connecting_status();
          this.update_actions();
        }, this);
        this.set({ports: this.ports});

        this.connectable_vms = new Backbone.FilteredCollection(undefined, {
          collection: synnefo.storage.vms,
          collectionFilter: function(m) {
            return m.can_connect();
          }
        });
        models.Network.__super__.initialize.apply(this, arguments);
        this.update_actions();
      },
      
      update_actions: function() {
        if (this.ports.length) {
          this.set({can_remove: false})
        } else {
          this.set({can_remove: true})
        }
      },

      update_connecting_status: function() {
        if (this.pending_connections <= 0) {
          this.pending_connections = 0;
        }
        if (this.pending_disconnects <= 0) {
          this.pending_disconnects = 0;
        }
        this.trigger('change:status', this.get('status'));
      },

      get_nics: function() {
        return this.nics.models
      },

      is_public: function() {
        return this.get('router:external')
      },

      connect_vm: function(vm, cb) {
        var self = this;
        var data = {
          port: {
            network_id: this.id,
            device_id: vm.id
          }
        }

        this.pending_connections++;
        this.update_connecting_status();
        synnefo.storage.ports.create(data, {complete: cb});
      },

      reassign_to_project: function(project, success, cb) {
        var project_id = project.id ? project.id : project;
        var self = this;
        var _success = function() {
          success();
          self.set({'tenant_id': project_id});
        }
        synnefo.api.sync('create', this, {
          success: _success,
          complete: cb,
          data: { 
            reassign: { 
              project: project_id 
            }
          }
        });
      }
    });
    
    models.CombinedPublicNetwork = models.Network.extend({
      defaults: {
        'admin_state_up': true,
        'id': 'snf-combined-public-network',
        'name': 'Internet',
        'status': 'ACTIVE',
        'router:external': true,
        'shared': false,
        'rename_disabled': true,
        'subnets': []
      },
        
      group_by: 'name',
      group_networks: [],

      initialize: function(attributes) {
        this.groupKey = attributes.name;
        var self = this;
        this.ports = new Backbone.FilteredCollection(undefined, {
          collection: synnefo.storage.ports,
          collectionFilter: function(m) {
            return m.get('network') && 
                   m.get('network').get(self.group_by) == self.groupKey;
          }
        });
        this.set({ports: this.ports});
        this.floating_ips = synnefo.storage.floating_ips;
        this.set({floating_ips: this.floating_ips});

        this.available_floating_ips = new Backbone.FilteredCollection(undefined, {
          collection: synnefo.storage.floating_ips,
          collectionFilter: function(m) {
            return !m.get('port_id');
          }
        });
        this.set({available_floating_ips: this.available_floating_ips});
        this.set({name: attributes.name || 'Internet'});
        models.Network.__super__.initialize.call(this, attributes);
      }
    });

    models.Networks = models.NetworkCollection.extend({
      model: models.Network,
      path: 'networks',
      details: true,

      parse: function(resp) {
        var data = _.map(resp.networks, function(net) {
          if (!net.name) {
            net.name = '(no name set)';
          }
          return net
        })
        return resp.networks
      },

      get_floating_ips_network: function() {
        return this.filter(function(n) { return n.get('is_public') })[1]
      },
      
      create_subnet: function(subnet_params, complete, error) {
        synnefo.storage.subnets.create(subnet_params, {
          complete: function () { complete && complete() },
          error: function() { error && error() }
        });
      },

      create: function (project, name, type, cidr, dhcp, gateway, callback) {
        var quota = synnefo.storage.quotas;
        var params = {network:{name:name}};
        var subnet_params = {subnet:{network_id:undefined}};
        if (!type) { throw "Network type cannot be empty"; }

        params.network.type = type;
        params.network.project = project.id;
        if (cidr) { subnet_params.subnet.cidr = cidr; }
        if (dhcp) { subnet_params.subnet.dhcp_enabled = dhcp; }
        if (dhcp === false) { subnet_params.subnet.dhcp_enabled = false; }
        
        // api applies a gateway address automatically when gateway_ip 
        // parameter is missing
        if (gateway !== "auto") {
            subnet_params.subnet.gateway_ip = gateway || null;
        }
        
        var cb = function() {
          synnefo.api.trigger("quotas:call");
          callback && callback();
        }
        
        var complete = function() {
          if (!create_subnet) { cb && cb() }
        };
        var error = function() { cb() };
        var create_subnet = !!cidr;
        
        // on network create success, try to create the requested network 
        // subnet.
        var self = this;
        var success = function(resp) {
          var network = resp.network;
          if (create_subnet) {
            subnet_params.subnet.network_id = network.id;
            self.create_subnet(subnet_params, cb, function() {
              // rollback network creation
              var created_network = new synnefo.models.networks.Network({
                id: network.id
              });
              created_network.destroy({no_skip: true});
            });
          }
          project.quotas.get('cyclades.network.private').increase();
        }
        return this.api_call(this.path, "create", params, complete, error, success);
      }
    });
    
    // dummy model/collection
    models.FixedIP = models.NetworkModel.extend({
      storage_attrs: {
        'subnet_id': ['subnets', 'subnet']
      }
    });
    models.FixedIPs = models.NetworkCollection.extend({
      model: models.FixedIP
    });

    models.Port = models.NetworkModel.extend({
      path: 'ports',
      parse: function(obj) {
        return obj.port;
      },
      initialize: function() {
        models.Port.__super__.initialize.apply(this, arguments);
        var ips = new models.FixedIPs();
        this.set({'ips': ips});
        this.bind('change:fixed_ips', function() {
          var ips = this.get('ips');
          //var ips = _.map(ips, function(ip) { ip.id = ip.a})
          this.update_ips()
        }, this);
        this.update_ips();
        this.set({'pending_firewall': null});
      },
      
      update_ips: function() {
        var self = this;
        var ips = _.map(this.get('fixed_ips'), function(ip_obj) {
          var ip = _.clone(ip_obj);
          var type = "v4";
          if (ip.ip_address.indexOf(":") >= 0) {
            type = "v6";
          }
          ip.id = ip.ip_address;
          ip.type = type;
          ip.subnet_id = ip.subnet;
          ip.port_id = self.id;
          delete ip.subnet;
          return ip;
        });
        this.get('ips').update(ips, {removeMissing: true});
      },

      model_actions: {
        'disconnect': [['status', 'network', 'vm'], function() {
          var network = this.get('network');
          if ((!network || network.get('is_public')) && (network && !network.get('is_floating'))) {
            return false
          }
          var vm_active = this.get('vm') && this.get('vm').is_active();
          if (!synnefo.config.hotplug_enabled && this.get('vm') && vm_active) {
            return false;
          }
          if (this.get('device_id'))
          var status_ok = _.contains(['DOWN', 'ACTIVE', 'CONNECTED'], 
                                     this.get('status'));
          var vm_status_ok = this.get('vm') && this.get('vm').can_connect();
          var vm_status = this.get('vm') && this.get('vm').get('status');
          return status_ok && vm_status_ok
        }]
      },

      storage_attrs: {
        'device_id': ['vms', 'vm'],
        'network_id': ['networks', 'network']
      },

      proxy_attrs: {
        'firewall_status': [
          ['vm'], function(vm) {
            var attachment = vm && vm.get_attachment(this.id);
            if (!attachment) { return "DISABLED" }
            return attachment.firewallProfile
          } 
        ],
        'ext_status': [
          ['status'], function() {
            if (_.contains(["DISCONNECTING"], this.get('ext_status'))) {
              return this.get("ext_status")
            }
            return this.get("status")
          }
        ],
        'in_progress': [
          ['ext_status', 'vm'], function() {
            var vm_progress = this.get('vm') && this.get('vm').get('in_progress');
            if (vm_progress) { return true }
            return _.contains(["BUILD", "DISCONNECTING", "CONNECTING"], this.get("ext_status"))
          }
        ],
        // check progress of port instance only
        'in_progress_no_vm': [
          ['ext_status'], function() {
            return _.contains(["BUILD", "DISCONNECTING", "CONNECTING"], this.get("ext_status"))
          }
        ],
        'firewall_running': [
          ['firewall_status', 'pending_firewall'], function(status, pending) {
              var pending = this.get('pending_firewall');
              var status = this.get('firewall_status');
              if (!pending) { return false }
              if (status == pending) {
                this.set({'pending_firewall': null});
              }
              return status != pending;
          }
        ],
      },

      disconnect: function(cb) {
        var network = this.get('network');
        var vm = this.get('vm');
        network.pending_disconnects++;
        network.update_connecting_status();
        var success = _.bind(function() {
          if (vm) {
            vm.set({'status': 'DISCONNECTING'});
          }
          this.set({'status': 'DISCONNECTING'});
          cb && cb();
        }, this);
        this.destroy({success: success, complete: cb, silent: true});
      }
    });

    models.Ports = models.NetworkCollection.extend({
      model: models.Port,
      path: 'ports',
      details: true,
      noUpdate: true,
      updateEntries: true,

      parse: function(data) {
        return data.ports;
      },

      comparator: function(m) {
          return parseInt(m.id);
      }
    });

    models.FloatingIP = models.NetworkModel.extend({
      path: 'floatingips',
    
      url: function(options, method) {
        var url = models.FloatingIP.__super__.url.call(this, method, options);
        if (options.data && options.data.reassign) {
          return url + '/action';
        }
        return url;
      },

      parse: function(obj) {
        return obj.floatingip;
      },

      storage_attrs: {
        'tenant_id': ['projects', 'project'],
        'port_id': ['ports', 'port'],
        'floating_network_id': ['networks', 'network'],
      },

      model_actions: {
        'remove': [['status'], function() {
          var status_ok = _.contains(['DISCONNECTED'], this.get('status'));
          return status_ok
        }],
        'connect': [['status'], function() {
          var status_ok = _.contains(['DISCONNECTED'], this.get('status'))
          return status_ok
        }],
        'disconnect': [['status', 'port_id', 'port'], function() {
          var port = this.get('port');
          if (!port) { return false }

          // not connected to a device
          if (port && !port.get('device_id')) { return true }
          return port.get('can_disconnect');
        }]
      },
      
      reassign_to_project: function(project, success, cb) {
        var project_id = project.id ? project.id : project;
        var self = this;
        var _success = function() {
          success();
          self.set({'tenant_id': project_id});
        }
        synnefo.api.sync('create', this, {
          success: _success,
          complete: cb,
          data: { 
            reassign: { 
              project: project_id 
            }
          }
        });
      },

      do_remove: function(succ, err) { return this.do_destroy(succ, err) },
      do_destroy: function(succ, err) {
        this.actions.reset_pending();
        this.destroy({
          success: _.bind(function() {
            synnefo.api.trigger("quotas:call", 10);
            this.set({status: 'REMOVING'});
            succ && succ();
          }, this),
          error: err || function() {},
          silent: true
        });
      },

      do_disconnect: function(succ, err) {
        this.actions.reset_pending();
        this.get('port').disconnect(succ);
      },

      proxy_attrs: {
        '_status': [
            ['status', 'port', 'port.vm'], function() {
                var status = this.get("status");
                var port = this.get("port");
                var vm = port && port.get("vm");
                return status + (vm ? vm.state() : "");
            }
        ],
        'ip': [
          ['floating_ip_adress'], function() {
            return this.get('floating_ip_address'); 
        }],

        'in_progress': [
          ['status'], function() {
            return _.contains(['CONNECTING', 'DISCONNECTING', 'REMOVING'], 
                              this.get('status'))
          }  
        ],

        'status': [
          ['port_id', 'port'], function() {
            var port_id = this.get('port_id');
            if (!port_id) {
              return 'DISCONNECTED'
            } else {
              var port = this.get('port');
              if (port) {
                var port_status = port.get('ext_status');
                if (port_status == "DISCONNECTING") {
                  return port_status
                }
                if (port_status == "CONNECTING") {
                  return port_status
                }
                return 'CONNECTED'
              }
              return 'CONNECTING'  
            }
          }
        ]
      }
    });

    models.FloatingIPs = models.NetworkCollection.extend({
      model: models.FloatingIP,
      details: false,
      path: 'floatingips',
      parse: function(resp) {
        return resp.floatingips;
      },
      comparator: function(m) {
        return parseInt(m.id);
      }
    });

    models.Router = models.NetworkModel.extend({
    });

    models.Routers = models.NetworkCollection.extend({
      model: models.Router,
      path: 'routers',
      parse: function(resp) {
        return resp.routers
      }
    });

    snf.storage.floating_ips = new models.FloatingIPs();
    snf.storage.routers = new models.Routers();
    snf.storage.networks = new models.Networks();
    snf.storage.ports = new models.Ports();
    snf.storage.subnets = new models.Subnets();

})(this);
