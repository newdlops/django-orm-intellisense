pub mod cache;
pub mod discovery;
pub mod features;
pub mod semantic;
pub mod static_index;

pub fn hello(name: &str) -> String {
    format!("hello, {name}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_works() {
        assert_eq!(hello("django"), "hello, django");
    }
}
