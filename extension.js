const St = imports.gi.St;
const Main = imports.ui.main;
const Lang = imports.lang;
const Clutter = imports.gi.Clutter;
const ExtensionUtils = imports.misc.extensionUtils;
const Shell = imports.gi.Shell;
const Meta = imports.gi.Meta;
const Mainloop = imports.mainloop;
const PopupMenu = imports.ui.popupMenu;

const Me = ExtensionUtils.getCurrentExtension();
const Utils = Me.imports.utils;
const TranslatorDialog = Me.imports.translator_dialog;
const StatusBar = Me.imports.status_bar;
const LanguageChooser = Me.imports.language_chooser;
const TranslatorsManager = Me.imports.translators_manager;
const PrefsKeys = Me.imports.prefs_keys;

ExtensionUtils.get_text_translator_extension = function() {
    return Me;
}

function launch_extension_prefs(uuid) {
    let appSys = Shell.AppSystem.get_default();
    let app = appSys.lookup_app('gnome-shell-extension-prefs.desktop');
    app.launch(global.display.get_current_time_roundtrip(),
               ['extension:///' + uuid], -1, null);
}

const TIMEOUT_IDS = {
    instant_translation: 0
};

const TRIGGERS = {
    translate: true
};

const CONNECTION_IDS = {
    show_icon: 0,
    enable_shortcuts: 0
};

const INSTANT_TRANSLATION_DELAY = 900; // ms

const TranslatorsPopup = new Lang.Class({
    Name: 'TranslatorsPopup',
    Extends: PopupMenu.PopupMenu,

    _init: function(button, dialog) {
        this._button = button;
        this._dialog = dialog;

        this.parent(this._button.actor, 0, St.Side.TOP);
        this.setSourceAlignment(0.05);

        this.actor.hide();
        Main.uiGroup.add_actor(this.actor);
    },

    add_item: function(name, action) {
        let item = new PopupMenu.PopupMenuItem(name);
        item.connect('activate', Lang.bind(this, function() {
            action();
            this.close();
        }));
        this.addMenuItem(item);
    },

    open: function() {
        this._button.set_sensitive(false);
        this._button.actor.add_style_pseudo_class('active');
        this.parent(true);
        this.firstMenuItem.actor.grab_key_focus();
    },

    close: function() {
        this.parent(true);
        this._button.set_sensitive(true);
        this._button.actor.remove_style_pseudo_class('active');
        this._dialog.source.grab_key_focus();
        this.destroy();
    }
});

const TranslatorExtension = new Lang.Class({
    Name: 'TranslatorExtension',

    _init: function() {
        this._dialog = new TranslatorDialog.TranslatorDialog();
        this._dialog.source.clutter_text.connect('text-changed',
            Lang.bind(this, function() {
                let enable_instant_translation = Utils.SETTINGS.get_boolean(
                    PrefsKeys.INSTANT_TRANSLATION_KEY
                );
                if(!enable_instant_translation) return;

                this._remove_timeouts('instant_translation');

                if(TRIGGERS.translate) {
                    TIMEOUT_IDS.instant_translation = Mainloop.timeout_add(
                        INSTANT_TRANSLATION_DELAY,
                        Lang.bind(this, this._translate)
                    );
                }
                else {
                    TRIGGERS.translate = true;
                }
            })
        );
        this._dialog.dialog_layout.connect('key-press-event', Lang.bind(this,
            this._on_key_press_event
        ));
        this._translators_manager = new TranslatorsManager.TranslatorsManager();

        this._dialog.source.max_length =
            this._translators_manager.current.limit;

        this._add_topbar_buttons();
        this._add_bottombar_buttons();

        this._source_language_chooser = new LanguageChooser.LanguageChooser(
            'Choose source language:'
        );
        this._source_language_chooser.connect('language-chose', Lang.bind(this,
            this._on_source_language_chose
        ));

        this._target_language_chooser = new LanguageChooser.LanguageChooser(
            'Choose target language:'
        );
        this._target_language_chooser.connect('language-chose', Lang.bind(this,
            this._on_target_language_chose
        ));

        this._set_current_languages();
    },

    _remove_timeouts: function(timeout_key) {
        if(!Utils.is_blank(timeout_key)) {
            if(TIMEOUT_IDS[timeout_key] > 0) {
                Mainloop.source_remove(TIMEOUT_IDS[timeout_key]);
            }
        }
        else {
            for(let key in TIMEOUT_IDS) {
                if(TIMEOUT_IDS[key] > 0) {
                    Mainloop.source_remove(TIMEOUT_IDS[key]);
                }
            }
        }
    },

    _on_key_press_event: function(object, event) {
        let state = event.get_state();
        let symbol = event.get_key_symbol();
        let code = event.get_key_code();

        let cyrillic_control = 8196;
        let cyrillic_shift = 8192;

        if(symbol == Clutter.Escape) {
            this.close();
        }
        // ctrl+return - translate text
        else if(
            (state == Clutter.ModifierType.CONTROL_MASK || state == cyrillic_control) &&
            (symbol == Clutter.Return || symbol == Clutter.KP_Enter)
        ) {
            this._translate();
        }
        // ctrl+shift+c - copy translated text to clipboard
        else if(
            (
                state == Clutter.ModifierType.SHIFT_MASK + Clutter.ModifierType.CONTROL_MASK ||
                state == Clutter.ModifierType.SHIFT_MASK + cyrillic_control
            ) &&
            code == 54
        ) {
            let text = this._dialog.target.text;

            if(Utils.is_blank(text)) {
                this._dialog.statusbar.add_message(
                    'There is nothing to copy.',
                    1500,
                    StatusBar.MESSAGE_TYPES.error,
                    false
                );
            }
            else {
                let clipboard = St.Clipboard.get_default();
                clipboard.set_text(text);
                this._dialog.statusbar.add_message(
                    'Translated text copied to clipboard.',
                    1500,
                    StatusBar.MESSAGE_TYPES.info,
                    false
                );
            }
        }
        // ctr+s - swap languages
        else if(
            (state == Clutter.ModifierType.CONTROL_MASK || state == cyrillic_control) &&
            code == 39
        ) {
            this._swap_languages();
        }
        // ctrl+d - reset languages to default
        else if(
            (state == Clutter.ModifierType.CONTROL_MASK || state == cyrillic_control) &&
            code == 40
        ) {
            this._reset_languages()
        }
        else {
            // let t = {
            //     state: state,
            //     symbol: symbol,
            //     code: code
            // };
            // log(JSON.stringify(t, null, '\t'));
        }
    },

    _set_current_translator: function(name) {
        this._translators_button.label = '<u>%s</u>'.format(name);

        this._translators_manager.current = name;
        this._dialog.source.max_length =
            this._translators_manager.current.limit;
        this._set_current_languages();

        this._dialog.source.grab_key_focus();
    },

    _set_current_source: function(lang_code) {
        this._current_source_lang = lang_code;
        this._translators_manager.current.prefs.last_source = lang_code;
    },

    _set_current_target: function(lang_code) {
        this._current_target_lang = lang_code;
        this._translators_manager.current.prefs.last_target = lang_code;
    },

    _set_current_languages: function() {
        let current_translator = this._translators_manager.current;
        let current_source = current_translator.prefs.default_source;
        let current_target = current_translator.prefs.default_target;

        if(current_translator.prefs.remember_last_lang) {
            current_source =
                current_translator.prefs.last_source !== false
                ? current_translator.prefs.last_source
                : current_translator.prefs.default_source;
            current_target =
                current_translator.prefs.last_target
                ? current_translator.prefs.last_target
                : current_translator.prefs.default_target;
        }

        this._set_current_source(current_source);
        this._set_current_target(current_target);
        this._current_langs_changed();
    },

    _swap_languages: function() {
        let current = this._translators_manager.current;
        let source = this._current_source_lang;
        let target = this._current_target_lang;
        this._set_current_source(target);
        this._set_current_target(source);
        this._current_langs_changed();
    },

    _reset_languages: function() {
        let current = this._translators_manager.current;
        this._set_current_source(current.prefs.default_source);
        this._set_current_target(current.prefs.default_target);
        this._current_langs_changed();
    },

    _show_help: function() {
        let help_dialog = new Me.imports.help_dialog.HelpDialog;
        help_dialog.open();
    },

    _on_source_language_chose: function(object, language) {
        this._set_current_source(language.code);
        this._current_langs_changed();
        this._source_language_chooser.close();
    },

    _on_target_language_chose: function(object, language) {
        this._set_current_target(language.code);
        this._current_langs_changed();
        this._target_language_chooser.close();
    },

    _current_langs_changed: function() {
        this._source_lang_button.label =
            '<u>From: %s</u>'.format(
                this._translators_manager.current.get_language_name(
                    this._current_source_lang
                )
            );
        this._target_lang_button.label =
            '<u>To: %s</u>'.format(
                this._translators_manager.current.get_language_name(
                    this._current_target_lang
                )
            );
    },

    _get_source_lang_button: function() {
        let button_params = {
            style_class: 'tranlator-top-bar-button-reactive'
        };
        let button = this._dialog.topbar.new_button(
            false,
            '<u>From: %s</u>'.format(
                this._translators_manager.current.get_language_name(
                    this._current_source_lang
                )
            ),
            button_params,
            Lang.bind(this, function() {
                this._source_language_chooser.open();
                this._source_language_chooser.set_languages(
                    this._translators_manager.current.get_languages()
                );
                this._source_language_chooser.show_languages(
                    this._current_source_lang
                );
            })
        );
        let message_id;

        button.connect('enter-event', Lang.bind(this, function() {
            message_id = this._dialog.statusbar.add_message(
                'Choose source language'
            );
        }));
        button.connect('leave-event', Lang.bind(this, function() {
            this._dialog.statusbar.remove_message(message_id);
        }));

        return button;
    },

    _get_target_lang_button: function() {
        let button_params = {
            style_class: 'tranlator-top-bar-button-reactive'
        };
        let button = this._dialog.topbar.new_button(
            false,
            '<u>To: %s</u>'.format(
                this._translators_manager.current.get_language_name(
                    this._current_target_lang
                )
            ),
            button_params,
            Lang.bind(this, function() {
                this._target_language_chooser.open();
                this._target_language_chooser.set_languages(
                    this._translators_manager.current.get_pairs(
                        this._current_source_lang
                    )
                );
                this._target_language_chooser.show_languages(
                    this._current_target_lang
                );
            })
        );
        let message_id;

        button.connect('enter-event', Lang.bind(this, function() {
            message_id = this._dialog.statusbar.add_message(
                'Choose target language'
            );
        }));
        button.connect('leave-event', Lang.bind(this, function() {
            this._dialog.statusbar.remove_message(message_id);
        }));

        return button;
    },

    _get_swap_langs_button: function() {
        let button_params = {
            style_class: 'tranlator-top-bar-button-reactive'
        };
        let button = this._dialog.topbar.new_button(
            false,
            ' <u>\u21C4</u> ',
            button_params,
            Lang.bind(this, this._swap_languages)
        );
        let message_id;

        button.connect('enter-event', Lang.bind(this, function() {
            message_id = this._dialog.statusbar.add_message(
                'Swap languages'
            );
        }));
        button.connect('leave-event', Lang.bind(this, function() {
            this._dialog.statusbar.remove_message(message_id);
        }));

        return button;
    },

    _get_translators_button: function() {
        let button;

        if(this._translators_manager.num_translators < 2) {
            button = this._dialog.topbar.new_label(
                this._translators_manager.current.name,
                'tranlator-top-bar-button'
            );
        }
        else {
            let button_params = {
                style_class: 'tranlator-top-bar-button-reactive'
            };
            button = this._dialog.topbar.new_button(
                false,
                '<u>%s</u>'.format(this._translators_manager.current.name),
                button_params,
                Lang.bind(this, function() {
                    let translators_popup = new TranslatorsPopup(button, this._dialog);
                    let names = this._translators_manager.translators_names;

                    for(let i = 0; i < names.length; i++) {
                        let name = names[i];
                        if(name === this._translators_manager.current.name) continue;

                        translators_popup.add_item(name, Lang.bind(this, function() {
                            this._set_current_translator(name);
                        }));
                    }

                    translators_popup.open();
                })
            );
            let message_id;

            button.connect('enter-event', Lang.bind(this, function() {
                message_id = this._dialog.statusbar.add_message(
                    'Choose translation provider'
                );
            }));
            button.connect('leave-event', Lang.bind(this, function() {
                this._dialog.statusbar.remove_message(message_id);
            }));
        }

        return button;
    },

    _get_translate_button: function() {
        let button_params = {
            style_class: 'tranlator-top-bar-go-button'
        };
        let button = this._dialog.topbar.new_button(
            false,
            'Go!',
            button_params,
            Lang.bind(this, this._translate)
        );

        let message_id;

        button.connect('enter-event', Lang.bind(this, function() {
            message_id = this._dialog.statusbar.add_message(
                'Translate text(<Ctrl><Enter>)'
            );
        }));
        button.connect('leave-event', Lang.bind(this, function() {
            this._dialog.statusbar.remove_message(message_id);
        }));

        return button;
    },

    _get_instant_translation_button: function() {
        let button_params = {
            style_class: 'translator-bottom-toggle-button',
            toggle_mode: true
        };

        let button = this._dialog.bottombar.new_button(
            Utils.ICONS.instant_translation,
            'Enable/Disable instant translation',
            button_params,
            Lang.bind(this, function() {
                let checked = button.get_checked();
                button.set_checked(checked);

                Utils.SETTINGS.set_boolean(
                    PrefsKeys.INSTANT_TRANSLATION_KEY,
                    checked
                )
            })
        );
        let checked = Utils.SETTINGS.get_boolean(
            PrefsKeys.INSTANT_TRANSLATION_KEY
        );
        button.set_checked(checked);

        return button;
    },

    _get_help_button: function() {
        let button_params = {
            style_class: 'translator-bottom-button'
        };

        let button = this._dialog.bottombar.new_button(
            Utils.ICONS.help,
            'Help',
            button_params,
            Lang.bind(this, this._show_help));

        return button;
    },

    _get_prefs_button: function() {
        let button_params = {
            style_class: 'translator-bottom-button'
        };
        let button = this._dialog.bottombar.new_button(
            Utils.ICONS.preferences,
            'Preferences',
            button_params,
            Lang.bind(this, function() {
                this.close();
                launch_extension_prefs(Me.uuid);
            })
        );

        return button;
    },

    _get_close_button: function() {
        let button_params = {
            style_class: 'translator-bottom-button'
        };
        let button = this._dialog.bottombar.new_button(
            Utils.ICONS.shutdown,
            'Quit',
            button_params,
            Lang.bind(this, function() {
                this.close();
            })
        );

        return button;
    },

    _add_topbar_buttons: function() {
        let translate_label = this._dialog.topbar.new_label(
            'Translate ',
            'tranlator-top-bar-button'
        );
        this._dialog.topbar.add_button(translate_label);

        this._source_lang_button = this._get_source_lang_button();
        this._dialog.topbar.add_button(this._source_lang_button);

        this._swap_languages_button = this._get_swap_langs_button();
        this._dialog.topbar.add_button(this._swap_languages_button);

        this._target_lang_button = this._get_target_lang_button();
        this._dialog.topbar.add_button(this._target_lang_button);

        let by_label = this._dialog.topbar.new_label(
            ' by ',
            'tranlator-top-bar-button'
        );
        this._dialog.topbar.add_button(by_label);

        this._translators_button = this._get_translators_button()
        this._dialog.topbar.add_button(this._translators_button);

        let translate_label = this._dialog.topbar.new_label(
            ' ',
            'tranlator-top-bar-button'
        );
        this._dialog.topbar.add_button(translate_label);

        this._translate_button = this._get_translate_button();
        this._dialog.topbar.add_button(this._translate_button);
    },

    _add_bottombar_buttons: function() {
        let instant_translation_button = this._get_instant_translation_button();
        this._dialog.bottombar.add_button(instant_translation_button);

        let help_button = this._get_help_button();
        this._dialog.bottombar.add_button(help_button);

        let prefs_button = this._get_prefs_button();
        this._dialog.bottombar.add_button(prefs_button);

        let close_button = this._get_close_button();
        this._dialog.bottombar.add_button(close_button);
    },

    _translate: function() {
        if(Utils.is_blank(this._dialog.source.text)) return;

        this._dialog.target.text = '';
        let message_id = this._dialog.statusbar.add_message(
            'Translating...',
            0,
            StatusBar.MESSAGE_TYPES.info,
            true
        );

        this._translators_manager.current.translate(
            this._current_source_lang,
            this._current_target_lang,
            this._dialog.source.text,
            Lang.bind(this, function(result) {
                this._dialog.statusbar.remove_message(message_id);

                if(result.error) {
                    this._dialog.statusbar.add_message(
                        result.message,
                        4000,
                        StatusBar.MESSAGE_TYPES.error
                    );
                }
                else {
                    this._dialog.target.markup ='%s'.format(result);
                }
            })
        );
    },

    _translate_from_clipboard: function() {
        this.open();

        let clipboard = St.Clipboard.get_default();
        clipboard.get_text(Lang.bind(this, function(clipboard, text) {
            if(Utils.is_blank(text)) {
                this._dialog.statusbar.add_message(
                    'Clipboard is empty.',
                    2000,
                    StatusBar.MESSAGE_TYPES.error,
                    false
                );
                return;
            }

            TRIGGERS.translate = false;
            this._dialog.source.text = text;
            this._translate();
        }))
    },

    _translate_from_selection: function() {
        this.open();

        let text = Utils.get_primary_selection();

        if(Utils.is_blank(text)) {
            this._dialog.statusbar.add_message(
                'Primary selection is empty.',
                2000,
                StatusBar.MESSAGE_TYPES.error,
                false
            );
            return;
        }

        TRIGGERS.translate = false;
        this._dialog.source.text = text;
        this._translate();
    },

    _add_keybindings: function() {
        global.display.add_keybinding(
            PrefsKeys.OPEN_TRANSLATOR_KEY,
            Utils.SETTINGS,
            Meta.KeyBindingFlags.NONE,
            Lang.bind(this, function() {
                this.open();
            })
        );
        global.display.add_keybinding(
            PrefsKeys.TRANSLATE_FROM_CLIPBOARD_KEY,
            Utils.SETTINGS,
            Meta.KeyBindingFlags.NONE,
            Lang.bind(this, function() {
                this._translate_from_clipboard();
            })
        );
        global.display.add_keybinding(
            PrefsKeys.TRANSLATE_FROM_SELECTION_KEY,
            Utils.SETTINGS,
            Meta.KeyBindingFlags.NONE,
            Lang.bind(this, function() {
                this._translate_from_selection();
            })
        );
    },

    _remove_keybindings: function() {
        global.display.remove_keybinding(PrefsKeys.OPEN_TRANSLATOR_KEY);
        global.display.remove_keybinding(PrefsKeys.TRANSLATE_FROM_CLIPBOARD_KEY)
        global.display.remove_keybinding(PrefsKeys.TRANSLATE_FROM_SELECTION_KEY);
    },

    _add_panel_button: function() {
        let label = new St.Label({
            text: 'T',
            style_class: 'translator-panel-button',
            reactive: true,
            track_hover: true
        });

        this._panel_button = new St.Button({
            x_fill: true,
            y_fill: false
        });
        this._panel_button.add_actor(label);
        this._panel_button.connect(
            'button-press-event',
            Lang.bind(this, this.open)
        );

        Main.panel._rightBox.insert_child_at_index(this._panel_button, 0);
    },

    _remove_panel_button: function() {
        Main.panel._rightBox.remove_child(this._panel_button);
        this._panel_button.destroy();
        this._panel_button = false;
    },

    open: function() {
        if(Utils.SETTINGS.get_boolean(PrefsKeys.REMEMBER_LAST_TRANSLATOR_KEY)) {
            let translator =
                this._translators_manager.last_used
                ? this._translators_manager.last_used.name
                : this._translators_manager.default.name;
            this._set_current_translator(translator);
        }
        else {
            this._set_current_translator(this._translators_manager.default.name);
        }

        this._dialog.open();
        this._dialog.source.clutter_text.set_selection(
            0,
            this._dialog.source.length
        );
        this._dialog.source.clutter_text.grab_key_focus();
        this._dialog.source.max_length = this._translators_manager.current.limit;
        this._set_current_languages();

        if(this._panel_button) {
            let label = this._panel_button.get_first_child();
            label.remove_style_pseudo_class('hover');
        }
    },

    close: function() {
        this._dialog.close();
    },

    enable: function() {
        if(Utils.SETTINGS.get_boolean(PrefsKeys.SHOW_ICON_KEY)) {
            if(!this._panel_button) {
                this._add_panel_button();
            }
        }

        if(Utils.SETTINGS.get_boolean(PrefsKeys.ENABLE_SHORTCUTS_KEY)) {
            this._add_keybindings();
        }

        CONNECTION_IDS.show_icon =
            Utils.SETTINGS.connect('changed::'+PrefsKeys.SHOW_ICON_KEY,
                Lang.bind(this, function() {
                    let show = Utils.SETTINGS.get_boolean(PrefsKeys.SHOW_ICON_KEY);

                    if(show && !this._panel_button) this._add_panel_button();
                    if(!show) this._remove_panel_button();
                })
            );
        CONNECTION_IDS.enable_shortcuts =
            Utils.SETTINGS.connect('changed::'+PrefsKeys.ENABLE_SHORTCUTS_KEY,
                Lang.bind(this, function() {
                    let enable = Utils.SETTINGS.get_boolean(
                        PrefsKeys.ENABLE_SHORTCUTS_KEY
                    );

                    if(enable) this._add_keybindings();
                    else this._remove_keybindings();
                })
            );
    },

    disable: function() {
        this.close();
        this._dialog.destroy();
        this._translators_manager.destroy();
        this._source_language_chooser.destroy();
        this._target_language_chooser.destroy();
        this._remove_keybindings();

        if(CONNECTION_IDS.show_icon > 0) {
            Utils.SETTINGS.disconnect(CONNECTION_IDS.show_icon);
        }

        if(CONNECTION_IDS.enable_shortcuts > 0) {
            Utils.SETTINGS.disconnect(CONNECTION_IDS.enable_shortcuts);
        }

        if(this._panel_button !== false) {
            this._remove_panel_button();
        }
    }
});

let translator = null;

function init() {
    // nothing
}

function enable() {
    translator = new TranslatorExtension();
    translator.enable();
}

function disable() {
    if(translator !== null) {
        translator.disable();
        translator = null;
    }
}
