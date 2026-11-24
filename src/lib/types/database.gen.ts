export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      auth_sign_in_requests: {
        Row: {
          created_at: string
          email_hash: string
          id: number
          ip_hash: string | null
          outcome: string
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          email_hash: string
          id?: never
          ip_hash?: string | null
          outcome: string
        }
        Update: {
          created_at?: string
          email_hash?: string
          id?: never
          ip_hash?: string | null
          outcome?: string
        }
        Relationships: []
      }
      billing_audit_log: {
        Row: {
          actor_kind: string
          actor_ref: string | null
          actor_user_id: string | null
          billing_line_item_id: string | null
          billing_period_id: string | null
          created_at: string
          details: NonNullable<Json>
          event_type: Database["public"]["Enums"]["billing_audit_event_type"]
          id: string
          org_id: string | null
        }
        ComputedFields: never
        Insert: {
          actor_kind?: string
          actor_ref?: string | null
          actor_user_id?: string | null
          billing_line_item_id?: string | null
          billing_period_id?: string | null
          created_at?: string
          details?: NonNullable<Json>
          event_type: Database["public"]["Enums"]["billing_audit_event_type"]
          id?: string
          org_id?: string | null
        }
        Update: {
          actor_kind?: string
          actor_ref?: string | null
          actor_user_id?: string | null
          billing_line_item_id?: string | null
          billing_period_id?: string | null
          created_at?: string
          details?: NonNullable<Json>
          event_type?: Database["public"]["Enums"]["billing_audit_event_type"]
          id?: string
          org_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "billing_audit_log_billing_line_item_id_fkey"
            columns: ["billing_line_item_id"]
            isOneToOne: false
            referencedRelation: "billing_line_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_audit_log_billing_period_id_fkey"
            columns: ["billing_period_id"]
            isOneToOne: false
            referencedRelation: "billing_periods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_audit_log_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_line_items: {
        Row: {
          billing_period_id: string
          created_at: string
          device_id: string | null
          end_kwh: number | null
          entered_at: string | null
          entered_by_user_id: string | null
          id: string
          invoice_number: string | null
          manual_reason: string | null
          paid_at: string | null
          paid_by_user_id: string | null
          payment_failed_at: string | null
          payment_notes: string | null
          payment_refunded_at: string | null
          payment_status: Database["public"]["Enums"]["billing_line_item_payment_status"]
          pesapal_order_id: string | null
          pesapal_redirect_url: string | null
          reading_source: Database["public"]["Enums"]["billing_line_item_reading_source"]
          short_slug: string | null
          start_kwh: number | null
          tenant_id: string
          tier_breakdown: NonNullable<Json>
          total_amount: number
          updated_at: string
          usage_kwh: number | null
        }
        ComputedFields: never
        Insert: {
          billing_period_id: string
          created_at?: string
          device_id?: string | null
          end_kwh?: number | null
          entered_at?: string | null
          entered_by_user_id?: string | null
          id?: string
          invoice_number?: string | null
          manual_reason?: string | null
          paid_at?: string | null
          paid_by_user_id?: string | null
          payment_failed_at?: string | null
          payment_notes?: string | null
          payment_refunded_at?: string | null
          payment_status?: Database["public"]["Enums"]["billing_line_item_payment_status"]
          pesapal_order_id?: string | null
          pesapal_redirect_url?: string | null
          reading_source?: Database["public"]["Enums"]["billing_line_item_reading_source"]
          short_slug?: string | null
          start_kwh?: number | null
          tenant_id: string
          tier_breakdown?: NonNullable<Json>
          total_amount?: number
          updated_at?: string
          usage_kwh?: number | null
        }
        Update: {
          billing_period_id?: string
          created_at?: string
          device_id?: string | null
          end_kwh?: number | null
          entered_at?: string | null
          entered_by_user_id?: string | null
          id?: string
          invoice_number?: string | null
          manual_reason?: string | null
          paid_at?: string | null
          paid_by_user_id?: string | null
          payment_failed_at?: string | null
          payment_notes?: string | null
          payment_refunded_at?: string | null
          payment_status?: Database["public"]["Enums"]["billing_line_item_payment_status"]
          pesapal_order_id?: string | null
          pesapal_redirect_url?: string | null
          reading_source?: Database["public"]["Enums"]["billing_line_item_reading_source"]
          short_slug?: string | null
          start_kwh?: number | null
          tenant_id?: string
          tier_breakdown?: NonNullable<Json>
          total_amount?: number
          updated_at?: string
          usage_kwh?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "billing_line_items_billing_period_id_fkey"
            columns: ["billing_period_id"]
            isOneToOne: false
            referencedRelation: "billing_periods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_line_items_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_line_items_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "microgrid_shared_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_line_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_periods: {
        Row: {
          closed_at: string | null
          created_at: string
          end_date: string
          id: string
          microgrid_id: string
          rate_schedule_id: string | null
          start_date: string
          status: Database["public"]["Enums"]["billing_period_status"]
          timezone: string
        }
        ComputedFields: never
        Insert: {
          closed_at?: string | null
          created_at?: string
          end_date: string
          id?: string
          microgrid_id: string
          rate_schedule_id?: string | null
          start_date: string
          status?: Database["public"]["Enums"]["billing_period_status"]
          timezone?: string
        }
        Update: {
          closed_at?: string | null
          created_at?: string
          end_date?: string
          id?: string
          microgrid_id?: string
          rate_schedule_id?: string | null
          start_date?: string
          status?: Database["public"]["Enums"]["billing_period_status"]
          timezone?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_periods_microgrid_id_fkey"
            columns: ["microgrid_id"]
            isOneToOne: false
            referencedRelation: "microgrids"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_periods_rate_schedule_id_fkey"
            columns: ["rate_schedule_id"]
            isOneToOne: false
            referencedRelation: "rate_schedules"
            referencedColumns: ["id"]
          },
        ]
      }
      communities: {
        Row: {
          address_city: string | null
          address_country: string | null
          address_line1: string | null
          address_line2: string | null
          address_postal_code: string | null
          address_region: string | null
          created_at: string
          geography_notes: string | null
          id: string
          invoice_config: NonNullable<Json>
          invoice_prefix: string | null
          name: string
          org_id: string
          payment_last_configured_at: string | null
          payment_provider:
            Database["public"]["Enums"]["payment_provider_type"] | null
          payment_provider_config: Json | null
          payment_provider_secret_encrypted: string | null
        }
        ComputedFields: never
        Insert: {
          address_city?: string | null
          address_country?: string | null
          address_line1?: string | null
          address_line2?: string | null
          address_postal_code?: string | null
          address_region?: string | null
          created_at?: string
          geography_notes?: string | null
          id?: string
          invoice_config?: NonNullable<Json>
          invoice_prefix?: string | null
          name: string
          org_id: string
          payment_last_configured_at?: string | null
          payment_provider?:
            Database["public"]["Enums"]["payment_provider_type"] | null
          payment_provider_config?: Json | null
          payment_provider_secret_encrypted?: string | null
        }
        Update: {
          address_city?: string | null
          address_country?: string | null
          address_line1?: string | null
          address_line2?: string | null
          address_postal_code?: string | null
          address_region?: string | null
          created_at?: string
          geography_notes?: string | null
          id?: string
          invoice_config?: NonNullable<Json>
          invoice_prefix?: string | null
          name?: string
          org_id?: string
          payment_last_configured_at?: string | null
          payment_provider?:
            Database["public"]["Enums"]["payment_provider_type"] | null
          payment_provider_config?: Json | null
          payment_provider_secret_encrypted?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "communities_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      community_payment_overrides: {
        Row: {
          community_id: string
          created_at: string
          id: string
          merchant_account_id: string | null
          org_id: string
          updated_at: string
        }
        ComputedFields: never
        Insert: {
          community_id: string
          created_at?: string
          id?: string
          merchant_account_id?: string | null
          org_id: string
          updated_at?: string
        }
        Update: {
          community_id?: string
          created_at?: string
          id?: string
          merchant_account_id?: string | null
          org_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "community_payment_overrides_community_id_fkey"
            columns: ["community_id"]
            isOneToOne: true
            referencedRelation: "communities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "community_payment_overrides_merchant_account_id_fkey"
            columns: ["merchant_account_id"]
            isOneToOne: false
            referencedRelation: "payment_merchant_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "community_payment_overrides_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      devices: {
        Row: {
          config: NonNullable<Json>
          created_at: string
          device_type: Database["public"]["Enums"]["device_type"]
          edge_id: string
          id: string
          name: string
          openems_component_id: string | null
        }
        ComputedFields: never
        Insert: {
          config?: NonNullable<Json>
          created_at?: string
          device_type: Database["public"]["Enums"]["device_type"]
          edge_id: string
          id?: string
          name: string
          openems_component_id?: string | null
        }
        Update: {
          config?: NonNullable<Json>
          created_at?: string
          device_type?: Database["public"]["Enums"]["device_type"]
          edge_id?: string
          id?: string
          name?: string
          openems_component_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "devices_edge_id_fkey"
            columns: ["edge_id"]
            isOneToOne: false
            referencedRelation: "edges"
            referencedColumns: ["id"]
          },
        ]
      }
      edges: {
        Row: {
          created_at: string
          id: string
          microgrid_id: string
          name: string
          openems_edge_id: string
          role: string | null
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          id?: string
          microgrid_id: string
          name: string
          openems_edge_id: string
          role?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          microgrid_id?: string
          name?: string
          openems_edge_id?: string
          role?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "edges_microgrid_id_fkey"
            columns: ["microgrid_id"]
            isOneToOne: false
            referencedRelation: "microgrids"
            referencedColumns: ["id"]
          },
        ]
      }
      grid_tariffs: {
        Row: {
          bands: NonNullable<Json>
          created_at: string
          effective_from: string
          id: string
          microgrid_id: string
        }
        ComputedFields: never
        Insert: {
          bands: NonNullable<Json>
          created_at?: string
          effective_from: string
          id?: string
          microgrid_id: string
        }
        Update: {
          bands?: NonNullable<Json>
          created_at?: string
          effective_from?: string
          id?: string
          microgrid_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "grid_tariffs_microgrid_id_fkey"
            columns: ["microgrid_id"]
            isOneToOne: false
            referencedRelation: "microgrids"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_counters: {
        Row: {
          community_id: string
          counter: number
          year: number
        }
        ComputedFields: never
        Insert: {
          community_id: string
          counter?: number
          year: number
        }
        Update: {
          community_id?: string
          counter?: number
          year?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoice_counters_community_id_fkey"
            columns: ["community_id"]
            isOneToOne: false
            referencedRelation: "communities"
            referencedColumns: ["id"]
          },
        ]
      }
      meter_readings: {
        Row: {
          created_at: string
          device_id: string
          id: string
          read_at: string
          reading_kwh: number
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          device_id: string
          id?: string
          read_at: string
          reading_kwh: number
        }
        Update: {
          created_at?: string
          device_id?: string
          id?: string
          read_at?: string
          reading_kwh?: number
        }
        Relationships: [
          {
            foreignKeyName: "meter_readings_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meter_readings_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "microgrid_shared_devices"
            referencedColumns: ["id"]
          },
        ]
      }
      mgm_plugin_audit_log: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          id: string
          new_enabled: boolean
          org_id: string
          plugin_name: string
          previous_enabled: boolean | null
        }
        ComputedFields: never
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          id?: string
          new_enabled: boolean
          org_id: string
          plugin_name: string
          previous_enabled?: boolean | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          id?: string
          new_enabled?: boolean
          org_id?: string
          plugin_name?: string
          previous_enabled?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "mgm_plugin_audit_log_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      mgm_plugins: {
        Row: {
          created_at: string
          enabled: boolean
          id: string
          org_id: string
          plugin_name: string
          updated_at: string
          version: string
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          enabled?: boolean
          id?: string
          org_id: string
          plugin_name: string
          updated_at?: string
          version: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          id?: string
          org_id?: string
          plugin_name?: string
          updated_at?: string
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "mgm_plugins_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      microgrid_savings_settings: {
        Row: {
          arbitrage_from: string | null
          microgrid_id: string
          round_trip_efficiency: number
          solar_savings_from: string | null
          updated_at: string
        }
        ComputedFields: never
        Insert: {
          arbitrage_from?: string | null
          microgrid_id: string
          round_trip_efficiency?: number
          solar_savings_from?: string | null
          updated_at?: string
        }
        Update: {
          arbitrage_from?: string | null
          microgrid_id?: string
          round_trip_efficiency?: number
          solar_savings_from?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "microgrid_savings_settings_microgrid_id_fkey"
            columns: ["microgrid_id"]
            isOneToOne: true
            referencedRelation: "microgrids"
            referencedColumns: ["id"]
          },
        ]
      }
      microgrids: {
        Row: {
          address_city: string | null
          address_country: string | null
          address_line1: string | null
          address_line2: string | null
          address_postal_code: string | null
          address_region: string | null
          community_id: string
          created_at: string
          created_by: string | null
          currency: string
          ems_aws_access_key_id: string | null
          ems_aws_region: string | null
          ems_aws_secret_access_key_encrypted: string | null
          ems_backend_url: string | null
          ems_basic_auth_password_encrypted: string | null
          ems_basic_auth_username: string | null
          ems_bearer_token_encrypted: string | null
          ems_keycloak_client_id: string | null
          ems_keycloak_client_secret_encrypted: string | null
          ems_keycloak_token_url: string | null
          ems_known_edge_ids: string[]
          ems_last_discover_at: string | null
          ems_last_discover_count: number | null
          ems_last_discover_error: string | null
          ems_last_discover_status: string | null
          ems_type: Database["public"]["Enums"]["microgrid_ems_type"] | null
          id: string
          lat: number | null
          lng: number | null
          name: string
          timezone: string
        }
        ComputedFields: never
        Insert: {
          address_city?: string | null
          address_country?: string | null
          address_line1?: string | null
          address_line2?: string | null
          address_postal_code?: string | null
          address_region?: string | null
          community_id: string
          created_at?: string
          created_by?: string | null
          currency?: string
          ems_aws_access_key_id?: string | null
          ems_aws_region?: string | null
          ems_aws_secret_access_key_encrypted?: string | null
          ems_backend_url?: string | null
          ems_basic_auth_password_encrypted?: string | null
          ems_basic_auth_username?: string | null
          ems_bearer_token_encrypted?: string | null
          ems_keycloak_client_id?: string | null
          ems_keycloak_client_secret_encrypted?: string | null
          ems_keycloak_token_url?: string | null
          ems_known_edge_ids?: string[]
          ems_last_discover_at?: string | null
          ems_last_discover_count?: number | null
          ems_last_discover_error?: string | null
          ems_last_discover_status?: string | null
          ems_type?: Database["public"]["Enums"]["microgrid_ems_type"] | null
          id?: string
          lat?: number | null
          lng?: number | null
          name: string
          timezone?: string
        }
        Update: {
          address_city?: string | null
          address_country?: string | null
          address_line1?: string | null
          address_line2?: string | null
          address_postal_code?: string | null
          address_region?: string | null
          community_id?: string
          created_at?: string
          created_by?: string | null
          currency?: string
          ems_aws_access_key_id?: string | null
          ems_aws_region?: string | null
          ems_aws_secret_access_key_encrypted?: string | null
          ems_backend_url?: string | null
          ems_basic_auth_password_encrypted?: string | null
          ems_basic_auth_username?: string | null
          ems_bearer_token_encrypted?: string | null
          ems_keycloak_client_id?: string | null
          ems_keycloak_client_secret_encrypted?: string | null
          ems_keycloak_token_url?: string | null
          ems_known_edge_ids?: string[]
          ems_last_discover_at?: string | null
          ems_last_discover_count?: number | null
          ems_last_discover_error?: string | null
          ems_last_discover_status?: string | null
          ems_type?: Database["public"]["Enums"]["microgrid_ems_type"] | null
          id?: string
          lat?: number | null
          lng?: number | null
          name?: string
          timezone?: string
        }
        Relationships: [
          {
            foreignKeyName: "microgrids_community_id_fkey"
            columns: ["community_id"]
            isOneToOne: false
            referencedRelation: "communities"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_email_senders: {
        Row: {
          created_at: string
          from_address: string
          from_name: string | null
          host: string
          last_test_message: string | null
          last_test_status: string | null
          last_tested_at: string | null
          org_id: string
          password_encrypted: string
          port: number
          reply_to: string | null
          updated_at: string
          username: string
          version: number
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          from_address: string
          from_name?: string | null
          host: string
          last_test_message?: string | null
          last_test_status?: string | null
          last_tested_at?: string | null
          org_id: string
          password_encrypted: string
          port: number
          reply_to?: string | null
          updated_at?: string
          username: string
          version?: number
        }
        Update: {
          created_at?: string
          from_address?: string
          from_name?: string | null
          host?: string
          last_test_message?: string | null
          last_test_status?: string | null
          last_tested_at?: string | null
          org_id?: string
          password_encrypted?: string
          port?: number
          reply_to?: string | null
          updated_at?: string
          username?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "organization_email_senders_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          address_city: string | null
          address_country: string | null
          address_line1: string | null
          address_line2: string | null
          address_postal_code: string | null
          address_region: string | null
          created_at: string
          id: string
          name: string
        }
        ComputedFields: never
        Insert: {
          address_city?: string | null
          address_country?: string | null
          address_line1?: string | null
          address_line2?: string | null
          address_postal_code?: string | null
          address_region?: string | null
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          address_city?: string | null
          address_country?: string | null
          address_line1?: string | null
          address_line2?: string | null
          address_postal_code?: string | null
          address_region?: string | null
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      payment_attempts: {
        Row: {
          amount: number
          bill_revision_total: number
          bill_revision_updated_at: string | null
          checkout_url: string | null
          community_id: string | null
          created_at: string
          currency: string
          failure_code: string | null
          failure_message: string | null
          id: string
          line_item_id: string
          merchant_account_id: string | null
          merchant_account_version: number
          merchant_reference: string
          org_id: string
          provider: string
          provider_tracking_id: string | null
          resolve_notes: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: string
          updated_at: string
        }
        ComputedFields: never
        Insert: {
          amount: number
          bill_revision_total?: number
          bill_revision_updated_at?: string | null
          checkout_url?: string | null
          community_id?: string | null
          created_at?: string
          currency?: string
          failure_code?: string | null
          failure_message?: string | null
          id?: string
          line_item_id: string
          merchant_account_id?: string | null
          merchant_account_version?: number
          merchant_reference: string
          org_id: string
          provider?: string
          provider_tracking_id?: string | null
          resolve_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          amount?: number
          bill_revision_total?: number
          bill_revision_updated_at?: string | null
          checkout_url?: string | null
          community_id?: string | null
          created_at?: string
          currency?: string
          failure_code?: string | null
          failure_message?: string | null
          id?: string
          line_item_id?: string
          merchant_account_id?: string | null
          merchant_account_version?: number
          merchant_reference?: string
          org_id?: string
          provider?: string
          provider_tracking_id?: string | null
          resolve_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_attempts_community_id_fkey"
            columns: ["community_id"]
            isOneToOne: false
            referencedRelation: "communities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_attempts_line_item_id_fkey"
            columns: ["line_item_id"]
            isOneToOne: false
            referencedRelation: "billing_line_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_attempts_merchant_account_id_fkey"
            columns: ["merchant_account_id"]
            isOneToOne: false
            referencedRelation: "payment_merchant_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_attempts_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_events: {
        Row: {
          actor_kind: string
          actor_ref: string | null
          actor_user_id: string | null
          at: string
          from_status:
            | Database["public"]["Enums"]["billing_line_item_payment_status"]
            | null
          id: string
          line_item_id: string
          raw_payload: Json | null
          source: string
          to_status: Database["public"]["Enums"]["billing_line_item_payment_status"]
        }
        ComputedFields: never
        Insert: {
          actor_kind?: string
          actor_ref?: string | null
          actor_user_id?: string | null
          at?: string
          from_status?:
            | Database["public"]["Enums"]["billing_line_item_payment_status"]
            | null
          id?: string
          line_item_id: string
          raw_payload?: Json | null
          source: string
          to_status: Database["public"]["Enums"]["billing_line_item_payment_status"]
        }
        Update: {
          actor_kind?: string
          actor_ref?: string | null
          actor_user_id?: string | null
          at?: string
          from_status?:
            | Database["public"]["Enums"]["billing_line_item_payment_status"]
            | null
          id?: string
          line_item_id?: string
          raw_payload?: Json | null
          source?: string
          to_status?: Database["public"]["Enums"]["billing_line_item_payment_status"]
        }
        Relationships: [
          {
            foreignKeyName: "payment_events_line_item_id_fkey"
            columns: ["line_item_id"]
            isOneToOne: false
            referencedRelation: "billing_line_items"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_merchant_accounts: {
        Row: {
          base_url: string
          consumer_key: string
          created_at: string
          disabled: boolean
          display_name: string
          id: string
          ipn_id: string | null
          ipn_url: string | null
          is_default: boolean
          last_test_message: string | null
          last_test_status: string | null
          last_tested_at: string | null
          org_id: string
          provider: string
          sandbox: boolean
          secret_encrypted: string | null
          updated_at: string
          version: number
        }
        ComputedFields: never
        Insert: {
          base_url?: string
          consumer_key?: string
          created_at?: string
          disabled?: boolean
          display_name?: string
          id?: string
          ipn_id?: string | null
          ipn_url?: string | null
          is_default?: boolean
          last_test_message?: string | null
          last_test_status?: string | null
          last_tested_at?: string | null
          org_id: string
          provider?: string
          sandbox?: boolean
          secret_encrypted?: string | null
          updated_at?: string
          version?: number
        }
        Update: {
          base_url?: string
          consumer_key?: string
          created_at?: string
          disabled?: boolean
          display_name?: string
          id?: string
          ipn_id?: string | null
          ipn_url?: string | null
          is_default?: boolean
          last_test_message?: string | null
          last_test_status?: string | null
          last_tested_at?: string | null
          org_id?: string
          provider?: string
          sandbox?: boolean
          secret_encrypted?: string | null
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "payment_merchant_accounts_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_merchant_versions: {
        Row: {
          account_id: string
          configuration: NonNullable<Json>
          created_at: string
          org_id: string
          version: number
        }
        ComputedFields: never
        Insert: {
          account_id: string
          configuration: NonNullable<Json>
          created_at?: string
          org_id: string
          version: number
        }
        Update: {
          account_id?: string
          configuration?: NonNullable<Json>
          created_at?: string
          org_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "payment_merchant_versions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "payment_merchant_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_merchant_versions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_notifications: {
        Row: {
          attempt_count: number
          created_at: string
          id: string
          last_error: string | null
          merchant_reference: string
          next_retry_at: string
          org_id: string | null
          processed_attempt_id: string | null
          provider: string
          raw_payload: NonNullable<Json>
          status: string
          tracking_id: string
          updated_at: string
        }
        ComputedFields: never
        Insert: {
          attempt_count?: number
          created_at?: string
          id?: string
          last_error?: string | null
          merchant_reference: string
          next_retry_at?: string
          org_id?: string | null
          processed_attempt_id?: string | null
          provider?: string
          raw_payload?: NonNullable<Json>
          status?: string
          tracking_id: string
          updated_at?: string
        }
        Update: {
          attempt_count?: number
          created_at?: string
          id?: string
          last_error?: string | null
          merchant_reference?: string
          next_retry_at?: string
          org_id?: string | null
          processed_attempt_id?: string | null
          provider?: string
          raw_payload?: NonNullable<Json>
          status?: string
          tracking_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_notifications_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_notifications_processed_attempt_id_fkey"
            columns: ["processed_attempt_id"]
            isOneToOne: false
            referencedRelation: "payment_attempts"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_receipts: {
        Row: {
          amount: number
          attempt_id: string
          confirmation_code: string | null
          created_at: string
          currency: string
          id: string
          org_id: string
          payment_method: string | null
          provider: string
          provider_status: string
          provider_tracking_id: string | null
          raw_payload: NonNullable<Json>
        }
        ComputedFields: never
        Insert: {
          amount: number
          attempt_id: string
          confirmation_code?: string | null
          created_at?: string
          currency?: string
          id?: string
          org_id: string
          payment_method?: string | null
          provider?: string
          provider_status: string
          provider_tracking_id?: string | null
          raw_payload?: NonNullable<Json>
        }
        Update: {
          amount?: number
          attempt_id?: string
          confirmation_code?: string | null
          created_at?: string
          currency?: string
          id?: string
          org_id?: string
          payment_method?: string | null
          provider?: string
          provider_status?: string
          provider_tracking_id?: string | null
          raw_payload?: NonNullable<Json>
        }
        Relationships: [
          {
            foreignKeyName: "payment_receipts_attempt_id_fkey"
            columns: ["attempt_id"]
            isOneToOne: false
            referencedRelation: "payment_attempts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_receipts_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      pilot_import_batches: {
        Row: {
          applied_at: string | null
          billing_period_id: string
          conflict_count: number
          created_at: string
          duplicate_source_row_count: number
          id: string
          initiated_by: string | null
          inserted_reading_count: number
          is_baseline: boolean
          reading_count: number
          source_label: string
          status: string
          tenant_count: number
          unchanged_reading_count: number
        }
        ComputedFields: never
        Insert: {
          applied_at?: string | null
          billing_period_id: string
          conflict_count?: number
          created_at?: string
          duplicate_source_row_count?: number
          id?: string
          initiated_by?: string | null
          inserted_reading_count?: number
          is_baseline?: boolean
          reading_count?: number
          source_label: string
          status?: string
          tenant_count?: number
          unchanged_reading_count?: number
        }
        Update: {
          applied_at?: string | null
          billing_period_id?: string
          conflict_count?: number
          created_at?: string
          duplicate_source_row_count?: number
          id?: string
          initiated_by?: string | null
          inserted_reading_count?: number
          is_baseline?: boolean
          reading_count?: number
          source_label?: string
          status?: string
          tenant_count?: number
          unchanged_reading_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "pilot_import_batches_billing_period_id_fkey"
            columns: ["billing_period_id"]
            isOneToOne: false
            referencedRelation: "billing_periods"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_schedules: {
        Row: {
          created_at: string
          id: string
          microgrid_id: string
          service_charge: number
          service_charge_description: string | null
          tax_rate: number
          tiers: NonNullable<Json>
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          id?: string
          microgrid_id: string
          service_charge?: number
          service_charge_description?: string | null
          tax_rate?: number
          tiers?: NonNullable<Json>
        }
        Update: {
          created_at?: string
          id?: string
          microgrid_id?: string
          service_charge?: number
          service_charge_description?: string | null
          tax_rate?: number
          tiers?: NonNullable<Json>
        }
        Relationships: [
          {
            foreignKeyName: "rate_schedules_microgrid_id_fkey"
            columns: ["microgrid_id"]
            isOneToOne: false
            referencedRelation: "microgrids"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_access_accounts: {
        Row: {
          first_recorded_at: string
          user_id: string
        }
        ComputedFields: never
        Insert: {
          first_recorded_at?: string
          user_id: string
        }
        Update: {
          first_recorded_at?: string
          user_id?: string
        }
        Relationships: []
      }
      tenant_access_accounts: {
        Row: {
          first_granted_at: string
          user_id: string
        }
        ComputedFields: never
        Insert: {
          first_granted_at?: string
          user_id: string
        }
        Update: {
          first_granted_at?: string
          user_id?: string
        }
        Relationships: []
      }
      tenant_devices: {
        Row: {
          created_at: string
          device_id: string
          effective_from: string
          effective_to: string | null
          id: string
          role: Database["public"]["Enums"]["tenant_device_role"]
          tenant_id: string
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          device_id: string
          effective_from?: string
          effective_to?: string | null
          id?: string
          role: Database["public"]["Enums"]["tenant_device_role"]
          tenant_id: string
        }
        Update: {
          created_at?: string
          device_id?: string
          effective_from?: string
          effective_to?: string | null
          id?: string
          role?: Database["public"]["Enums"]["tenant_device_role"]
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_devices_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_devices_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "microgrid_shared_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_devices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          account_number: string | null
          address_city: string | null
          address_country: string | null
          address_line1: string | null
          address_line2: string | null
          address_postal_code: string | null
          address_region: string | null
          created_at: string
          customer_type: string
          display_name: string
          geography_notes: string | null
          id: string
          meter_serial: string | null
          meter_type: string
          microgrid_id: string
          primary_email: string | null
          primary_phone: string
          unit_label: string | null
        }
        ComputedFields: never
        Insert: {
          account_number?: string | null
          address_city?: string | null
          address_country?: string | null
          address_line1?: string | null
          address_line2?: string | null
          address_postal_code?: string | null
          address_region?: string | null
          created_at?: string
          customer_type?: string
          display_name: string
          geography_notes?: string | null
          id?: string
          meter_serial?: string | null
          meter_type?: string
          microgrid_id: string
          primary_email?: string | null
          primary_phone: string
          unit_label?: string | null
        }
        Update: {
          account_number?: string | null
          address_city?: string | null
          address_country?: string | null
          address_line1?: string | null
          address_line2?: string | null
          address_postal_code?: string | null
          address_region?: string | null
          created_at?: string
          customer_type?: string
          display_name?: string
          geography_notes?: string | null
          id?: string
          meter_serial?: string | null
          meter_type?: string
          microgrid_id?: string
          primary_email?: string | null
          primary_phone?: string
          unit_label?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenants_microgrid_id_fkey"
            columns: ["microgrid_id"]
            isOneToOne: false
            referencedRelation: "microgrids"
            referencedColumns: ["id"]
          },
        ]
      }
      user_profiles: {
        Row: {
          created_at: string
          first_name: string | null
          last_name: string | null
          phone: string | null
          updated_at: string
          user_id: string
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          first_name?: string | null
          last_name?: string | null
          phone?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          first_name?: string | null
          last_name?: string | null
          phone?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["user_role"]
          scope_id: string | null
          scope_microgrid_id: string | null
          scope_org_id: string | null
          scope_tenant_id: string | null
          scope_type: Database["public"]["Enums"]["role_scope_type"]
          user_id: string
        }
        ComputedFields: never
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["user_role"]
          scope_id?: string | null
          scope_microgrid_id?: never
          scope_org_id?: never
          scope_tenant_id?: never
          scope_type: Database["public"]["Enums"]["role_scope_type"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["user_role"]
          scope_id?: string | null
          scope_microgrid_id?: never
          scope_org_id?: never
          scope_tenant_id?: never
          scope_type?: Database["public"]["Enums"]["role_scope_type"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_roles_scope_microgrid_fkey"
            columns: ["scope_microgrid_id"]
            isOneToOne: false
            referencedRelation: "microgrids"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_roles_scope_org_fkey"
            columns: ["scope_org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_roles_scope_tenant_fkey"
            columns: ["scope_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      microgrid_recent_activity: {
        Row: {
          description: string | null
          kind: string | null
          microgrid_id: string | null
          timestamp: string | null
        }
        ComputedFields: never
        Relationships: []
      }
      microgrid_shared_devices: {
        Row: {
          config: NonNullable<Json>
          created_at: string
          device_type: Database["public"]["Enums"]["device_type"]
          edge_id: string
          id: string
          microgrid_id: string
          name: string
          openems_component_id: string | null
        }
        ComputedFields: never
        Relationships: [
          {
            foreignKeyName: "devices_edge_id_fkey"
            columns: ["edge_id"]
            isOneToOne: false
            referencedRelation: "edges"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "edges_microgrid_id_fkey"
            columns: ["microgrid_id"]
            isOneToOne: false
            referencedRelation: "microgrids"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      fn_apply_payment_event: {
        Args: {
          _actor_kind?: string
          _actor_ref?: string
          _actor_user_id: string
          _line_item_id: string
          _raw_payload: Json
          _source: string
          _to_status: Database["public"]["Enums"]["billing_line_item_payment_status"]
        }
        Returns: {
          billing_period_id: string
          created_at: string
          device_id: string | null
          end_kwh: number | null
          entered_at: string | null
          entered_by_user_id: string | null
          id: string
          invoice_number: string | null
          manual_reason: string | null
          paid_at: string | null
          paid_by_user_id: string | null
          payment_failed_at: string | null
          payment_notes: string | null
          payment_refunded_at: string | null
          payment_status: Database["public"]["Enums"]["billing_line_item_payment_status"]
          pesapal_order_id: string | null
          pesapal_redirect_url: string | null
          reading_source: Database["public"]["Enums"]["billing_line_item_reading_source"]
          short_slug: string | null
          start_kwh: number | null
          tenant_id: string
          tier_breakdown: NonNullable<Json>
          total_amount: number
          updated_at: string
          usage_kwh: number | null
        }
        SetofOptions: {
          from: "*"
          to: "billing_line_items"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      fn_auth_access_token_hook: { Args: { event: Json }; Returns: Json }
      fn_auth_claim_sign_in_request: {
        Args: { _email_hash: string; _ip_hash: string }
        Returns: number
      }
      fn_auth_sign_in_target: { Args: { _email: string }; Returns: string }
      fn_billing_period_close_review: {
        Args: { _period_id: string }
        Returns: Json
      }
      fn_change_user_role: {
        Args: {
          p_role: Database["public"]["Enums"]["user_role"]
          p_scope_id?: string
          p_scope_type?: Database["public"]["Enums"]["role_scope_type"]
          p_user_id: string
        }
        Returns: undefined
      }
      fn_close_billing_period: {
        Args: { _acknowledged: string[]; _digest: string; _period_id: string }
        Returns: {
          closed_at: string | null
          created_at: string
          end_date: string
          id: string
          microgrid_id: string
          rate_schedule_id: string | null
          start_date: string
          status: Database["public"]["Enums"]["billing_period_status"]
          timezone: string
        }[]
        SetofOptions: {
          from: "*"
          to: "billing_periods"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      fn_create_billing_period: {
        Args: { _end_date: string; _microgrid_id: string; _start_date: string }
        Returns: {
          closed_at: string | null
          created_at: string
          end_date: string
          id: string
          microgrid_id: string
          rate_schedule_id: string | null
          start_date: string
          status: Database["public"]["Enums"]["billing_period_status"]
          timezone: string
        }[]
        SetofOptions: {
          from: "*"
          to: "billing_periods"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      fn_create_tenant: {
        Args: {
          p_account_number?: string
          p_address_city?: string
          p_address_country?: string
          p_address_line1?: string
          p_address_line2?: string
          p_address_postal_code?: string
          p_address_region?: string
          p_customer_type?: string
          p_device_id?: string
          p_display_name: string
          p_geography_notes?: string
          p_meter_serial?: string
          p_meter_type?: string
          p_microgrid_id: string
          p_primary_email?: string
          p_primary_phone?: string
          p_unit_label?: string
        }
        Returns: string
      }
      fn_create_tenant_with_meter: {
        Args: {
          p_account_number?: string
          p_address_city?: string
          p_address_country?: string
          p_address_line1?: string
          p_address_line2?: string
          p_address_postal_code?: string
          p_address_region?: string
          p_customer_type?: string
          p_device_id: string
          p_display_name: string
          p_geography_notes?: string
          p_meter_serial?: string
          p_meter_type?: string
          p_microgrid_id: string
          p_primary_email?: string
          p_primary_phone?: string
          p_unit_label?: string
        }
        Returns: string
      }
      fn_delete_draft_billing_period: {
        Args: { _period_id: string }
        Returns: string
      }
      fn_edge_ids_all_nonempty: { Args: { ids: string[] }; Returns: boolean }
      fn_ems_decrypt_secret: { Args: { p_ciphertext: string }; Returns: string }
      fn_ems_encrypt_secret: { Args: { p_plaintext: string }; Returns: string }
      fn_entity_delete_community: { Args: { p_id: string }; Returns: number }
      fn_entity_delete_edge: { Args: { p_id: string }; Returns: number }
      fn_entity_delete_microgrid: { Args: { p_id: string }; Returns: number }
      fn_entity_delete_org: { Args: { p_id: string }; Returns: number }
      fn_finalize_user_invitation: {
        Args: {
          p_first_name: string
          p_last_name: string
          p_phone: string
          p_role: Database["public"]["Enums"]["user_role"]
          p_scope_id?: string
          p_user_id: string
        }
        Returns: undefined
      }
      fn_get_ems_basic_auth_password: {
        Args: { _microgrid_id: string }
        Returns: string
      }
      fn_get_ems_bearer_token: {
        Args: { _microgrid_id: string }
        Returns: string
      }
      fn_get_ems_keycloak_client_secret: {
        Args: { _microgrid_id: string }
        Returns: string
      }
      fn_get_ems_secret: { Args: { _microgrid_id: string }; Returns: string }
      fn_get_payment_merchant_secret: {
        Args: { _account_id: string }
        Returns: string
      }
      fn_list_ems_operators: {
        Args: { _microgrid_id: string }
        Returns: {
          display_name: string
          user_id: string
        }[]
      }
      fn_list_visible_users: {
        Args: { _target_user_ids?: string[] }
        Returns: {
          email: string
          email_confirmed_at: string
          ems_operator_count: number
          first_name: string
          last_name: string
          last_sign_in_at: string
          phone: string
          role: Database["public"]["Enums"]["user_role"]
          scope_id: string
          scope_type: Database["public"]["Enums"]["role_scope_type"]
          user_id: string
        }[]
      }
      fn_mgm_bootstrap_first_organization: {
        Args: {
          _address_city: string
          _address_country: string
          _address_line1?: string
          _address_line2?: string
          _address_postal_code?: string
          _address_region?: string
          _community_management_version: string
          _name: string
          _operator_user_id: string
          _organization_directory_version: string
        }
        Returns: {
          address_city: string | null
          address_country: string | null
          address_line1: string | null
          address_line2: string | null
          address_postal_code: string | null
          address_region: string | null
          created_at: string
          id: string
          name: string
        }
        SetofOptions: {
          from: "*"
          to: "organizations"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      fn_mgm_set_plugin_enabled: {
        Args: {
          _enabled: boolean
          _org_id: string
          _plugin_name: string
          _plugin_version: string
        }
        Returns: {
          created_at: string
          enabled: boolean
          id: string
          org_id: string
          plugin_name: string
          updated_at: string
          version: string
        }
        SetofOptions: {
          from: "*"
          to: "mgm_plugins"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      fn_next_invoice_number: {
        Args: { p_community_id: string; p_year: number }
        Returns: number
      }
      fn_organization_email_sender_password: {
        Args: {
          _host: string
          _org_id: string
          _port: number
          _username: string
          _version: number
        }
        Returns: string
      }
      fn_payment_account_version: {
        Args: { _account_id: string; _org_id: string; _version: number }
        Returns: Json
      }
      fn_payment_commit_verification: {
        Args: {
          _amount: number
          _attempt_id: string
          _confirmation: string
          _currency: string
          _method: string
          _payload: Json
          _status: string
          _tracking: string
        }
        Returns: undefined
      }
      fn_payment_due_notifications: {
        Args: { _limit?: number }
        Returns: {
          attempt_count: number
          created_at: string
          id: string
          last_error: string | null
          merchant_reference: string
          next_retry_at: string
          org_id: string | null
          processed_attempt_id: string | null
          provider: string
          raw_payload: NonNullable<Json>
          status: string
          tracking_id: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "payment_notifications"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      fn_payment_enqueue_notification: {
        Args: {
          _org: string
          _payload: Json
          _reference: string
          _tracking: string
        }
        Returns: string
      }
      fn_payment_reconcile: {
        Args: {
          _action: string
          _actor: string
          _attempt_id: string
          _external_amount: number
          _notes: string
          _reference: string
        }
        Returns: undefined
      }
      fn_payment_reserve_checkout: {
        Args: {
          _account_id: string
          _account_version: number
          _amount: number
          _community_id: string
          _currency: string
          _line_item_id: string
          _org_id: string
          _reference: string
          _revision: string
        }
        Returns: {
          amount: number
          bill_revision_total: number
          bill_revision_updated_at: string | null
          checkout_url: string | null
          community_id: string | null
          created_at: string
          currency: string
          failure_code: string | null
          failure_message: string | null
          id: string
          line_item_id: string
          merchant_account_id: string | null
          merchant_account_version: number
          merchant_reference: string
          org_id: string
          provider: string
          provider_tracking_id: string | null
          resolve_notes: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "payment_attempts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      fn_payment_run_worker: {
        Args: Record<PropertyKey, never>
        Returns: number
      }
      fn_payment_save_account: {
        Args: { _account_id: string; _expected_version: number; _payload: Json }
        Returns: string
      }
      fn_pin_billing_period_rate_schedule: {
        Args: { _period_id: string }
        Returns: string
      }
      fn_record_first_line_item_with_audit: {
        Args: {
          _actor_kind?: string
          _actor_ref?: string
          _actor_user_id: string
          _audit_details: Json
          _billing_period_id: string
          _device_id: string
          _end_kwh: number
          _entered_by_user_id: string
          _manual_reason: string
          _rate_schedule_id: string
          _reading_source: Database["public"]["Enums"]["billing_line_item_reading_source"]
          _start_kwh: number
          _tenant_id: string
          _tier_breakdown: Json
          _total_amount: number
          _usage_kwh: number
        }
        Returns: {
          billing_period_id: string
          created_at: string
          device_id: string | null
          end_kwh: number | null
          entered_at: string | null
          entered_by_user_id: string | null
          id: string
          invoice_number: string | null
          manual_reason: string | null
          paid_at: string | null
          paid_by_user_id: string | null
          payment_failed_at: string | null
          payment_notes: string | null
          payment_refunded_at: string | null
          payment_status: Database["public"]["Enums"]["billing_line_item_payment_status"]
          pesapal_order_id: string | null
          pesapal_redirect_url: string | null
          reading_source: Database["public"]["Enums"]["billing_line_item_reading_source"]
          short_slug: string | null
          start_kwh: number | null
          tenant_id: string
          tier_breakdown: NonNullable<Json>
          total_amount: number
          updated_at: string
          usage_kwh: number | null
        }
        SetofOptions: {
          from: "*"
          to: "billing_line_items"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      fn_record_line_item_with_audit: {
        Args: {
          _actor_kind?: string
          _actor_ref?: string
          _actor_user_id: string
          _audit_details: Json
          _billing_period_id: string
          _device_id: string
          _end_kwh: number
          _entered_by_user_id: string
          _manual_reason: string
          _rate_schedule_id: string
          _reading_source: Database["public"]["Enums"]["billing_line_item_reading_source"]
          _start_kwh: number
          _tenant_id: string
          _tier_breakdown: Json
          _total_amount: number
          _usage_kwh: number
        }
        Returns: {
          billing_period_id: string
          created_at: string
          device_id: string | null
          end_kwh: number | null
          entered_at: string | null
          entered_by_user_id: string | null
          id: string
          invoice_number: string | null
          manual_reason: string | null
          paid_at: string | null
          paid_by_user_id: string | null
          payment_failed_at: string | null
          payment_notes: string | null
          payment_refunded_at: string | null
          payment_status: Database["public"]["Enums"]["billing_line_item_payment_status"]
          pesapal_order_id: string | null
          pesapal_redirect_url: string | null
          reading_source: Database["public"]["Enums"]["billing_line_item_reading_source"]
          short_slug: string | null
          start_kwh: number | null
          tenant_id: string
          tier_breakdown: NonNullable<Json>
          total_amount: number
          updated_at: string
          usage_kwh: number | null
        }
        SetofOptions: {
          from: "*"
          to: "billing_line_items"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      fn_regenerate_bill_with_audit: {
        Args: {
          _actor_kind?: string
          _actor_ref?: string
          _actor_user_id: string
          _audit_details: Json
          _billing_period_id: string
          _device_id: string
          _end_kwh: number
          _entered_by_user_id: string
          _expected: Json
          _manual_reason: string
          _rate_schedule_id: string
          _reading_source: Database["public"]["Enums"]["billing_line_item_reading_source"]
          _start_kwh: number
          _tenant_id: string
          _tier_breakdown: Json
          _total_amount: number
          _usage_kwh: number
        }
        Returns: {
          billing_period_id: string
          created_at: string
          device_id: string | null
          end_kwh: number | null
          entered_at: string | null
          entered_by_user_id: string | null
          id: string
          invoice_number: string | null
          manual_reason: string | null
          paid_at: string | null
          paid_by_user_id: string | null
          payment_failed_at: string | null
          payment_notes: string | null
          payment_refunded_at: string | null
          payment_status: Database["public"]["Enums"]["billing_line_item_payment_status"]
          pesapal_order_id: string | null
          pesapal_redirect_url: string | null
          reading_source: Database["public"]["Enums"]["billing_line_item_reading_source"]
          short_slug: string | null
          start_kwh: number | null
          tenant_id: string
          tier_breakdown: NonNullable<Json>
          total_amount: number
          updated_at: string
          usage_kwh: number | null
        }
        SetofOptions: {
          from: "*"
          to: "billing_line_items"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      fn_replace_tenant_device: {
        Args: {
          p_device_id: string
          p_effective_date: string
          p_tenant_id: string
        }
        Returns: string
      }
      fn_tenant_access_count: {
        Args: { _tenant_ids: string[] }
        Returns: number
      }
      fn_tenant_access_grant: {
        Args: { _actor: string; _tenant_id: string; _user_id: string }
        Returns: string
      }
      fn_tenant_access_list: {
        Args: { _tenant_id: string }
        Returns: {
          access_id: string
          created_at: string
          email: string
        }[]
      }
      fn_tenant_access_revoke: {
        Args: { _access_id: string; _tenant_id: string }
        Returns: boolean
      }
      fn_tenant_home: {
        Args: { _tenant_id: string }
        Returns: {
          currency: string
          display_name: string
          microgrid_id: string
          microgrid_name: string
          organization_id: string
          tenant_id: string
          timezone: string
          unit_label: string
        }[]
      }
      fn_tenant_shared_meter_days: {
        Args: { _from_date: string; _tenant_id: string; _to_date: string }
        Returns: {
          device_id: string
          effective_from: string
          effective_to: string
        }[]
      }
      is_super_admin: { Args: Record<PropertyKey, never>; Returns: boolean }
      mgm_plugin_enabled_for_org: {
        Args: { _org_id: string; _plugin_name: string }
        Returns: boolean
      }
      user_can_access_community: {
        Args: { _community_id: string }
        Returns: boolean
      }
      user_can_access_microgrid: {
        Args: { _microgrid_id: string }
        Returns: boolean
      }
      user_can_access_org: { Args: { _org_id: string }; Returns: boolean }
      user_can_access_tenant: { Args: { _tenant_id: string }; Returns: boolean }
      user_can_see_user_profile: {
        Args: { _target_user_id: string }
        Returns: boolean
      }
      user_is_tenant_of_device: {
        Args: { _device_id: string }
        Returns: boolean
      }
    }
    Enums: {
      billing_audit_event_type:
        | "period_created"
        | "period_closed"
        | "line_item_generated"
        | "line_item_regenerated"
        | "billing_period_created"
        | "token_generated"
        | "token_revoked"
        | "token_regenerated"
        | "tariff_reconciled"
      billing_line_item_payment_status:
        "unpaid" | "paid" | "failed" | "refunded" | "link_generated"
      billing_line_item_reading_source: "edge" | "manual"
      billing_period_status: "draft" | "closed"
      device_type:
        | "consumption_meter"
        | "grid_meter"
        | "pv_meter"
        | "battery"
        | "inverter"
        | "ev_charger"
        | "other"
      microgrid_ems_type: "cloud_aws" | "direct_url"
      payment_provider_type: "pesapal"
      role_scope_type: "org" | "microgrid" | "tenant"
      tenant_device_role:
        | "primary_consumption_meter"
        | "secondary_meter"
        | "battery"
        | "solar"
        | "ev_charger"
        | "other"
      user_role: "super_admin" | "org_manager" | "ems_operator" | "tenant"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      billing_audit_event_type: [
        "period_created",
        "period_closed",
        "line_item_generated",
        "line_item_regenerated",
        "billing_period_created",
        "token_generated",
        "token_revoked",
        "token_regenerated",
        "tariff_reconciled",
      ],
      billing_line_item_payment_status: [
        "unpaid",
        "paid",
        "failed",
        "refunded",
        "link_generated",
      ],
      billing_line_item_reading_source: ["edge", "manual"],
      billing_period_status: ["draft", "closed"],
      device_type: [
        "consumption_meter",
        "grid_meter",
        "pv_meter",
        "battery",
        "inverter",
        "ev_charger",
        "other",
      ],
      microgrid_ems_type: ["cloud_aws", "direct_url"],
      payment_provider_type: ["pesapal"],
      role_scope_type: ["org", "microgrid", "tenant"],
      tenant_device_role: [
        "primary_consumption_meter",
        "secondary_meter",
        "battery",
        "solar",
        "ev_charger",
        "other",
      ],
      user_role: ["super_admin", "org_manager", "ems_operator", "tenant"],
    },
  },
} as const
