import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { ISettingRegistry } from '@jupyterlab/settingregistry';

/**
 * Initialization data for the jupyter-engagement-helper extension.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyter-engagement-helper:plugin',
  description: 'Embed engagement data into notebooks',
  autoStart: true,
  optional: [ISettingRegistry],
  activate: (app: JupyterFrontEnd, settingRegistry: ISettingRegistry | null) => {
    console.log('JupyterLab extension jupyter-engagement-helper is activated!');

    if (settingRegistry) {
      settingRegistry
        .load(plugin.id)
        .then(settings => {
          console.log('jupyter-engagement-helper settings loaded:', settings.composite);
        })
        .catch(reason => {
          console.error('Failed to load settings for jupyter-engagement-helper.', reason);
        });
    }
  }
};

export default plugin;
