/**
 * Zentrale Plan-Definitionen für OPA! Santorini.
 * Diese Datei ist die EINZIGE Quelle der Wahrheit für alle Pläne.
 * Änderungen hier wirken sich automatisch auf Validierung, Tokens und Admin-Panel aus.
 */
export const PLAN_DEFINITIONS = {
    TRIAL: {
        label: 'Trial (30 Tage)',
        menu_items: 50,
        max_tables: 8,
        expires_days: 30,
        modules: {
            menu_edit:            true,
            multilanguage:        false,
            seasonal_menu:        false,
            orders_kitchen:       true,
            reservations_online:  false,
            reservations_phone:   true,
            custom_branding:      false,
            analytics:            false,
            qr_pay:               false,
            online_orders:        false,
            backup:               false,
            image_ai:             false
        }
    },
    FREE: {
        label: 'Free',
        menu_items: 30,
        max_tables: 5,
        expires_days: 36500,
        modules: {
            menu_edit: true,
            multilanguage: false,
            seasonal_menu: false,
            orders_kitchen: false,
            reservations_online: false,
            reservations_phone: true,
            custom_branding: false,
            analytics: false,
            qr_pay: false
        }
    },
    STARTER: {
        label: 'Starter',
        menu_items: 60,
        max_tables: 10,
        expires_days: 365,
        modules: {
            menu_edit: true,
            multilanguage: true,
            seasonal_menu: false,
            orders_kitchen: true,
            reservations_online: false,
            reservations_phone: true,
            custom_branding: false,
            analytics: false,
            qr_pay: false
        }
    },
    PRO: {
        label: 'Pro',
        menu_items: 150,
        max_tables: 25,
        expires_days: 365,
        modules: {
            menu_edit: true,
            multilanguage: true,
            seasonal_menu: true,
            orders_kitchen: true,
            reservations_online: true,
            reservations_phone: true,
            custom_branding: true,
            analytics: false,
            qr_pay: true
        }
    },
    PRO_PLUS: {
        label: 'Pro+',
        menu_items: 300,
        max_tables: 50,
        expires_days: 365,
        modules: {
            menu_edit: true,
            multilanguage: true,
            seasonal_menu: true,
            orders_kitchen: true,
            reservations_online: true,
            reservations_phone: true,
            custom_branding: true,
            analytics: true,
            qr_pay: true
        }
    },
    ENTERPRISE: {
        label: 'Enterprise',
        menu_items: 999,
        max_tables: 999,
        expires_days: 365,
        modules: {
            menu_edit: true,
            multilanguage: true,
            seasonal_menu: true,
            orders_kitchen: true,
            reservations_online: true,
            reservations_phone: true,
            custom_branding: true,
            analytics: true,
            qr_pay: true
        }
    }
};
